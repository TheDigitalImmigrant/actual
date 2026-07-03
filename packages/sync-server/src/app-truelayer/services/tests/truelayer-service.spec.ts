import { describe, expect, it } from 'vitest';

import {
  isImportableTransaction,
  normalizeAccount,
  normalizeBalance,
  normalizeCard,
  normalizeTransaction,
} from '#app-truelayer/services/truelayer-service';
import type {
  TrueLayerAccount,
  TrueLayerCard,
  TrueLayerTransaction,
} from '#app-truelayer/services/truelayer-service';
import { handleTrueLayerError } from '#app-truelayer/utils/errors';

const baseTransaction: TrueLayerTransaction = {
  transaction_id: 'tx-001',
  timestamp: '2026-06-15T09:30:00Z',
  description: 'TFL TRAVEL CH',
  amount: -5.4,
  currency: 'GBP',
  transaction_type: 'DEBIT',
  transaction_category: 'TRANSPORT',
  merchant_name: 'Transport for London',
};

describe('normalizeTransaction', () => {
  it('extracts the date from the timestamp', () => {
    const result = normalizeTransaction(baseTransaction, true);
    expect(result.date).toBe('2026-06-15');
  });

  it('forces DEBIT amounts negative regardless of provider sign', () => {
    const positiveDebit = { ...baseTransaction, amount: 5.4 };
    const result = normalizeTransaction(positiveDebit, true);
    expect(result.transactionAmount.amount).toBe('-5.4');
  });

  it('forces CREDIT amounts positive regardless of provider sign', () => {
    const negativeCredit: TrueLayerTransaction = {
      ...baseTransaction,
      transaction_type: 'CREDIT',
      amount: -100,
    };
    const result = normalizeTransaction(negativeCredit, true);
    expect(result.transactionAmount.amount).toBe('100');
  });

  it('preserves the provider sign when transaction_type is absent', () => {
    const noType: TrueLayerTransaction = {
      ...baseTransaction,
      transaction_type: undefined,
      amount: -12.34,
    };
    const result = normalizeTransaction(noType, true);
    expect(result.transactionAmount.amount).toBe('-12.34');
  });

  it('prefers merchant_name for the payee, falling back to description', () => {
    expect(normalizeTransaction(baseTransaction, true).payeeName).toBe(
      'Transport for London',
    );
    const noMerchant = { ...baseTransaction, merchant_name: undefined };
    expect(normalizeTransaction(noMerchant, true).payeeName).toBe(
      'TFL TRAVEL CH',
    );
  });

  it('falls back to meta.provider_transaction_id for the id', () => {
    const noId: TrueLayerTransaction = {
      ...baseTransaction,
      transaction_id: '',
      meta: { provider_transaction_id: 'prov-9' },
    };
    expect(normalizeTransaction(noId, true).transactionId).toBe('prov-9');
  });

  it('marks booked flag from the caller', () => {
    expect(normalizeTransaction(baseTransaction, true).booked).toBe(true);
    expect(normalizeTransaction(baseTransaction, false).booked).toBe(false);
  });
});

describe('isImportableTransaction', () => {
  it('accepts a well-formed transaction', () => {
    expect(
      isImportableTransaction(normalizeTransaction(baseTransaction, true)),
    ).toBe(true);
  });

  it('rejects an empty or malformed date', () => {
    const noTimestamp = { ...baseTransaction, timestamp: '' };
    expect(
      isImportableTransaction(normalizeTransaction(noTimestamp, false)),
    ).toBe(false);
    const badTimestamp = { ...baseTransaction, timestamp: 'not-a-date' };
    expect(
      isImportableTransaction(normalizeTransaction(badTimestamp, false)),
    ).toBe(false);
  });

  it('rejects a non-numeric amount', () => {
    const normalized = normalizeTransaction(baseTransaction, true);
    normalized.transactionAmount.amount = 'NaN';
    expect(isImportableTransaction(normalized)).toBe(false);
    normalized.transactionAmount.amount = ' ';
    expect(isImportableTransaction(normalized)).toBe(false);
  });
});

describe('normalizeBalance', () => {
  it('converts to integer minor units', () => {
    const balance = normalizeBalance({ currency: 'GBP', current: 33975.42 });
    expect(balance.balanceAmount.amount).toBe(3397542);
    expect(balance.balanceAmount.currency).toBe('GBP');
  });

  it('rounds float artifacts correctly', () => {
    expect(
      normalizeBalance({ currency: 'GBP', current: 262.24 }).balanceAmount
        .amount,
    ).toBe(26224);
    expect(
      normalizeBalance({ currency: 'GBP', current: 0.1 + 0.2 }).balanceAmount
        .amount,
    ).toBe(30);
  });
});

describe('normalizeAccount', () => {
  const account: TrueLayerAccount = {
    account_id: 'acc-1',
    account_type: 'TRANSACTION',
    display_name: 'PREMIER BANK',
    currency: 'GBP',
    account_number: { iban: 'GB00HSBC0000001', number: '00000001' },
    provider: { display_name: 'HSBC' },
  };

  it('maps name, institution, and iban', () => {
    const result = normalizeAccount(account);
    expect(result.account_id).toBe('acc-1');
    expect(result.name).toBe('PREMIER BANK');
    expect(result.official_name).toBe('PREMIER BANK');
    expect(result.institution).toBe('HSBC');
    expect(result.iban).toBe('GB00HSBC0000001');
    expect(result.type).toBe('account');
  });

  it('falls back through iban then account_id for the name', () => {
    const noName = { ...account, display_name: undefined };
    expect(normalizeAccount(noName).name).toBe('GB00HSBC0000001');
    const bare = { ...account, display_name: undefined, account_number: {} };
    expect(normalizeAccount(bare).name).toBe('acc-1');
  });

  it('defaults institution to Unknown', () => {
    expect(
      normalizeAccount({ ...account, provider: undefined }).institution,
    ).toBe('Unknown');
  });
});

describe('normalizeCard', () => {
  const card: TrueLayerCard = {
    account_id: 'card-1',
    card_network: 'VISA',
    display_name: undefined,
    partial_card_number: '4321',
    currency: 'GBP',
    provider: { display_name: 'HSBC' },
  };

  it('builds a masked name when display_name is missing', () => {
    const result = normalizeCard(card);
    expect(result.name).toBe('VISA ••4321');
    expect(result.mask).toBe('4321');
    expect(result.type).toBe('card');
  });

  it('prefers the display_name when present', () => {
    expect(normalizeCard({ ...card, display_name: 'My Card' }).name).toBe(
      'My Card',
    );
  });
});

describe('handleTrueLayerError', () => {
  it('maps 401/403 to INVALID_ACCESS_TOKEN (re-link)', () => {
    expect(handleTrueLayerError(401, {}).error_code).toBe(
      'INVALID_ACCESS_TOKEN',
    );
    expect(handleTrueLayerError(403, {}).error_code).toBe(
      'INVALID_ACCESS_TOKEN',
    );
  });

  it('maps invalid_grant (rotated/expired refresh token) to re-link', () => {
    const error = handleTrueLayerError(400, {
      error: 'invalid_grant',
      error_description: 'refresh token expired',
    });
    expect(error.error_code).toBe('INVALID_ACCESS_TOKEN');
    expect(error.message).toBe('refresh token expired');
  });

  it('maps 429 to RATE_LIMIT_EXCEEDED and 404 to NOT_FOUND', () => {
    expect(handleTrueLayerError(429, {}).error_code).toBe(
      'RATE_LIMIT_EXCEEDED',
    );
    expect(handleTrueLayerError(404, {}).error_code).toBe('NOT_FOUND');
  });

  it('keeps error_type as a machine-readable category, not the message', () => {
    const error = handleTrueLayerError(500, { error_description: 'boom' });
    expect(error.error_type).toBe('INTERNAL_ERROR');
    expect(error.error_code).toBe('INTERNAL_ERROR');
  });
});
