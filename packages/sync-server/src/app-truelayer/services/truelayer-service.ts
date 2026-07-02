import createDebug from 'debug';

import { secretsService } from '#services/secrets-service';

import { handleTrueLayerError, TrueLayerError } from '../utils/errors';

const debug = createDebug('actual:truelayer:service');

// Live by default; set TRUELAYER_ENV=sandbox to target the sandbox environment.
const SANDBOX = process.env.TRUELAYER_ENV === 'sandbox';
const AUTH_URL = SANDBOX
  ? 'https://auth.truelayer-sandbox.com'
  : 'https://auth.truelayer.com';
const API_URL = SANDBOX
  ? 'https://api.truelayer-sandbox.com'
  : 'https://api.truelayer.com';

// `balance` and `cards` widen the consent so both current/savings accounts and
// credit cards sync; `offline_access` is required to receive a refresh token.
const SCOPES = 'info accounts balance cards transactions offline_access';

// Secret keys. Client credentials use the fixed enum-style names; per-connection
// tokens are stored under a dynamic key so each linked bank keeps its own
// refresh token (mirrors GoCardless's per-requisition model).
const CLIENT_ID_KEY = 'truelayer_clientId';
const CLIENT_SECRET_KEY = 'truelayer_clientSecret';
const connectionKey = (connectionId: string) =>
  `truelayer_conn_${connectionId}`;

// --- Types ---

type StoredConnection = {
  access_token: string;
  refresh_token: string;
  // epoch ms at which the access token expires
  expires_at: number;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
};

export type TrueLayerProvider = {
  provider_id: string;
  display_name: string;
  logo_url?: string;
  country?: string;
};

type TrueLayerProviderRef = {
  display_name?: string;
  provider_id?: string;
};

export type TrueLayerAccount = {
  account_id: string;
  account_type?: string;
  display_name?: string;
  currency: string;
  account_number?: { iban?: string; number?: string; sort_code?: string };
  provider?: TrueLayerProviderRef;
};

export type TrueLayerCard = {
  account_id: string;
  card_network?: string;
  card_type?: string;
  display_name?: string;
  partial_card_number?: string;
  currency: string;
  provider?: TrueLayerProviderRef;
};

export type TrueLayerTransaction = {
  transaction_id: string;
  timestamp: string;
  description: string;
  amount: number;
  currency: string;
  transaction_type?: 'DEBIT' | 'CREDIT';
  transaction_category?: string;
  merchant_name?: string;
  running_balance?: { amount: number; currency: string };
  meta?: { provider_transaction_id?: string };
};

type TrueLayerBalance = {
  currency: string;
  available?: number;
  current: number;
};

type NormalizedTransaction = {
  transactionId: string;
  date: string;
  transactionAmount: { amount: string; currency: string };
  payeeName: string;
  notes?: string;
  booked: boolean;
  category?: string;
};

type NormalizedBalance = {
  balanceAmount: { amount: number; currency: string };
  balanceType: string;
};

type NormalizedAccount = {
  account_id: string;
  name: string;
  official_name: string;
  institution: string;
  currency: string;
  balance: number;
  type: 'account' | 'card';
  iban?: string;
  mask?: string;
};

// --- Credentials ---

function getCredentials(): { clientId: string; clientSecret: string } {
  // Secrets store takes precedence (set via the UI); env vars are a fallback so
  // self-hosters can configure credentials without the UI.
  const clientId =
    secretsService.get(CLIENT_ID_KEY) || process.env.TRUELAYER_CLIENT_ID;
  const clientSecret =
    secretsService.get(CLIENT_SECRET_KEY) || process.env.TRUELAYER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new TrueLayerError(
      'INVALID_INPUT',
      'NOT_CONFIGURED',
      'TrueLayer is not configured',
    );
  }
  return { clientId, clientSecret };
}

// --- HTTP helper ---

const REQUEST_TIMEOUT_MS = 30_000;

async function request<T>(
  method: string,
  url: string,
  accessToken: string,
): Promise<T> {
  debug('%s %s', method, url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new TrueLayerError('TIMED_OUT', 'TIMED_OUT', 'Request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => 'unknown');
    }
    throw handleTrueLayerError(response.status, body);
  }

  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- generic API wrapper, validated by caller
  return (await response.json()) as T;
}

// TrueLayer Data API wraps list responses in a `results` array.
async function requestResults<T>(
  path: string,
  accessToken: string,
): Promise<T[]> {
  const res = await request<{ results?: T[] }>(
    'GET',
    `${API_URL}${path}`,
    accessToken,
  );
  return res.results ?? [];
}

// --- OAuth ---

async function tokenRequest(
  params: Record<string, string>,
): Promise<TokenResponse> {
  const { clientId, clientSecret } = getCredentials();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${AUTH_URL}/connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        ...params,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => 'unknown');
    }
    throw handleTrueLayerError(response.status, body);
  }

  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- token endpoint response
  return (await response.json()) as TokenResponse;
}

// --- Per-connection token storage ---

function saveConnection(connectionId: string, token: TokenResponse): void {
  const stored: StoredConnection = {
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? '',
    expires_at: Date.now() + token.expires_in * 1000,
  };
  secretsService.set(connectionKey(connectionId), JSON.stringify(stored));
}

function loadConnection(connectionId: string): StoredConnection {
  const raw = secretsService.get(connectionKey(connectionId));
  if (!raw) {
    throw new TrueLayerError(
      'INVALID_ACCESS_TOKEN',
      'INVALID_ACCESS_TOKEN',
      'No stored TrueLayer connection; re-link required',
    );
  }
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- parsed from our own JSON
  return JSON.parse(raw) as StoredConnection;
}

// Returns a valid access token for a connection, transparently refreshing (and
// persisting the possibly-rotated refresh token) when the current one is stale.
async function getValidAccessToken(connectionId: string): Promise<string> {
  const conn = loadConnection(connectionId);

  // 60s skew so we refresh slightly before the token actually expires.
  if (Date.now() < conn.expires_at - 60_000) {
    return conn.access_token;
  }

  if (!conn.refresh_token) {
    throw new TrueLayerError(
      'INVALID_ACCESS_TOKEN',
      'INVALID_ACCESS_TOKEN',
      'TrueLayer access token expired and no refresh token is available',
    );
  }

  const refreshed = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: conn.refresh_token,
  });
  // TrueLayer may or may not rotate the refresh token; keep the old one if not.
  if (!refreshed.refresh_token) {
    refreshed.refresh_token = conn.refresh_token;
  }
  saveConnection(connectionId, refreshed);
  return refreshed.access_token;
}

// --- Normalization (single path; per-bank overrides slot in via PER_BANK_OVERRIDES) ---

// Seam for the rare bank whose TrueLayer data needs bespoke handling. Keyed by
// provider_id. Empty by default — TrueLayer normalizes across banks, so this
// exists so a one-off quirk becomes a small entry here rather than a rewrite.
const PER_BANK_OVERRIDES: Record<
  string,
  (normalized: NormalizedTransaction, raw: TrueLayerTransaction) => void
> = {};

const IMPORTABLE_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeTransaction(
  tx: TrueLayerTransaction,
  booked: boolean,
  providerId?: string,
): NormalizedTransaction {
  const transactionId = tx.transaction_id || tx.meta?.provider_transaction_id || '';
  const date = (tx.timestamp || '').slice(0, 10);

  // TrueLayer returns a signed amount, but re-derive the sign from
  // transaction_type when present so debits are always negative regardless of
  // per-provider sign conventions.
  const abs = Math.abs(tx.amount);
  let amount = tx.amount;
  if (tx.transaction_type === 'DEBIT') amount = -abs;
  else if (tx.transaction_type === 'CREDIT') amount = abs;

  const normalized: NormalizedTransaction = {
    transactionId,
    date,
    transactionAmount: { amount: String(amount), currency: tx.currency },
    payeeName: tx.merchant_name || tx.description || '',
    notes: tx.description,
    booked,
    category: tx.transaction_category,
  };

  if (providerId && PER_BANK_OVERRIDES[providerId]) {
    PER_BANK_OVERRIDES[providerId](normalized, tx);
  }
  return normalized;
}

// A record with an empty/non-ISO date or non-numeric amount makes Actual's
// client-side insert throw, aborting the whole account sync — skip those.
export function isImportableTransaction(tx: NormalizedTransaction): boolean {
  const amount = tx.transactionAmount.amount.trim();
  return (
    IMPORTABLE_DATE_REGEX.test(tx.date) &&
    amount !== '' &&
    Number.isFinite(Number(amount))
  );
}

export function normalizeBalance(bal: TrueLayerBalance): NormalizedBalance {
  return {
    balanceAmount: {
      amount: Math.round(bal.current * 100),
      currency: bal.currency,
    },
    balanceType: 'expected',
  };
}

export function normalizeAccount(acc: TrueLayerAccount): NormalizedAccount {
  const name = acc.display_name || acc.account_number?.iban || acc.account_id;
  return {
    account_id: acc.account_id,
    name,
    official_name: name,
    institution: acc.provider?.display_name || 'Unknown',
    currency: acc.currency,
    balance: 0,
    type: 'account',
    iban: acc.account_number?.iban,
  };
}

export function normalizeCard(card: TrueLayerCard): NormalizedAccount {
  const name =
    card.display_name ||
    (card.partial_card_number
      ? `${card.card_network || 'Card'} ••${card.partial_card_number}`
      : card.account_id);
  return {
    account_id: card.account_id,
    name,
    official_name: name,
    institution: card.provider?.display_name || 'Unknown',
    currency: card.currency,
    balance: 0,
    type: 'card',
    mask: card.partial_card_number,
  };
}

// --- Service ---

export const trueLayerService = {
  isConfigured(): boolean {
    return !!(
      (secretsService.get(CLIENT_ID_KEY) || process.env.TRUELAYER_CLIENT_ID) &&
      (secretsService.get(CLIENT_SECRET_KEY) ||
        process.env.TRUELAYER_CLIENT_SECRET)
    );
  },

  configure(clientId: string, clientSecret: string): void {
    secretsService.set(CLIENT_ID_KEY, clientId);
    secretsService.set(CLIENT_SECRET_KEY, clientSecret);
  },

  // Hosted auth URL. Restricting `providers` to the chosen provider deep-links
  // the user straight into that bank, implementing our own bank picker.
  buildAuthUrl(providerId: string, redirectUri: string, state: string): string {
    const { clientId } = getCredentials();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: SCOPES,
      redirect_uri: redirectUri,
      providers: providerId,
      state,
    });
    return `${AUTH_URL}/?${params.toString()}`;
  },

  // Lists providers available to this client (for the bank picker), filtered to
  // the given country. TrueLayer uses lowercase codes and "uk" (not "gb") for
  // the United Kingdom.
  async getProviders(country = 'uk'): Promise<TrueLayerProvider[]> {
    const { clientId } = getCredentials();
    const params = new URLSearchParams({
      client_id: clientId,
      scope: SCOPES,
      response_type: 'code',
    });
    const res = await fetch(`${AUTH_URL}/api/providers/?${params.toString()}`);
    if (!res.ok) {
      const body = await res.text().catch(() => 'unknown');
      throw handleTrueLayerError(res.status, body);
    }
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- providers metadata
    const providers = (await res.json()) as TrueLayerProvider[];
    const wanted = country.toLowerCase();
    return providers.filter(
      p => !wanted || !p.country || p.country.toLowerCase() === wanted,
    );
  },

  // Exchanges the auth code for tokens, persists them under a new connection id.
  async completeAuth(
    code: string,
    redirectUri: string,
    connectionId: string,
  ): Promise<void> {
    const token = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    saveConnection(connectionId, token);
  },

  removeConnection(connectionId: string): void {
    secretsService.set(connectionKey(connectionId), '');
  },

  async getAccountsAndCards(connectionId: string): Promise<NormalizedAccount[]> {
    const accessToken = await getValidAccessToken(connectionId);
    const [accounts, cards] = await Promise.all([
      requestResults<TrueLayerAccount>('/data/v1/accounts', accessToken),
      requestResults<TrueLayerCard>('/data/v1/cards', accessToken).catch(() => {
        // Not every connection grants card access; treat as no cards.
        return [] as TrueLayerCard[];
      }),
    ]);

    const normalized = [
      ...accounts.map(a => ({ acc: normalizeAccount(a), base: '/data/v1/accounts' })),
      ...cards.map(c => ({ acc: normalizeCard(c), base: '/data/v1/cards' })),
    ];

    // Enrich each account with its current balance (integer minor units) so the
    // link modal can show it. Best-effort — leave 0 if the balance call fails.
    await Promise.all(
      normalized.map(async ({ acc, base }) => {
        try {
          const balances = await requestResults<TrueLayerBalance>(
            `${base}/${acc.account_id}/balance`,
            accessToken,
          );
          if (balances.length) {
            acc.balance = Math.round(balances[0].current * 100);
          }
        } catch {
          // keep balance at 0
        }
      }),
    );

    return normalized.map(x => x.acc);
  },

  // Fetches balance + booked/pending transactions for one account or card.
  // `kind` selects the /accounts vs /cards resource path.
  async getTransactions(
    connectionId: string,
    accountId: string,
    kind: 'account' | 'card',
    dateFrom: string,
    dateTo: string,
    providerId?: string,
  ): Promise<{
    all: NormalizedTransaction[];
    booked: NormalizedTransaction[];
    pending: NormalizedTransaction[];
    startingBalance: number;
    balances: NormalizedBalance[];
  }> {
    const accessToken = await getValidAccessToken(connectionId);
    const base = kind === 'card' ? '/data/v1/cards' : '/data/v1/accounts';
    const range = `from=${encodeURIComponent(dateFrom)}&to=${encodeURIComponent(dateTo)}`;

    const [balanceResults, bookedRaw, pendingRaw] = await Promise.all([
      requestResults<TrueLayerBalance>(`${base}/${accountId}/balance`, accessToken),
      requestResults<TrueLayerTransaction>(
        `${base}/${accountId}/transactions?${range}`,
        accessToken,
      ),
      requestResults<TrueLayerTransaction>(
        `${base}/${accountId}/transactions/pending`,
        accessToken,
      ).catch(() => [] as TrueLayerTransaction[]),
    ]);

    const balances = balanceResults.map(normalizeBalance);
    const currentBalance = balances.length
      ? balances[0].balanceAmount.amount
      : 0;

    const booked: NormalizedTransaction[] = [];
    const pending: NormalizedTransaction[] = [];
    const all: NormalizedTransaction[] = [];

    for (const raw of bookedRaw) {
      const n = normalizeTransaction(raw, true, providerId);
      if (!isImportableTransaction(n)) continue;
      booked.push(n);
      all.push(n);
    }
    for (const raw of pendingRaw) {
      const n = normalizeTransaction(raw, false, providerId);
      if (!isImportableTransaction(n)) continue;
      pending.push(n);
      all.push(n);
    }

    // Reconstruct the balance *before* the imported transactions, so that
    // (startingBalance + imported transactions) equals the current balance
    // rather than double-counting it. Mirrors GoCardless calculateStartingBalance.
    const importedSumMinor = all.reduce(
      (total, tx) =>
        total + Math.round(parseFloat(tx.transactionAmount.amount) * 100),
      0,
    );
    const startingBalance = currentBalance - importedSumMinor;

    return { all, booked, pending, startingBalance, balances };
  },
};
