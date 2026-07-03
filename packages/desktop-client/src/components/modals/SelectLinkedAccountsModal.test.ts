import type { AccountEntity } from '@actual-app/core/types/models';

import { getInitialAccountSelections } from './SelectLinkedAccountsModal';

const CREATE_NEW = 'new-on';

function makeLocalAccount(
  id: string,
  accountId: string | null,
): AccountEntity {
  return { id, account_id: accountId, closed: 0 } as AccountEntity;
}

describe('getInitialAccountSelections', () => {
  it('preselects create-new for unmatched accounts in the fresh-connect flow', () => {
    const { initiallyChosenAccounts, initialDraftLinkAccounts } =
      getInitialAccountSelections({
        localAccounts: [makeLocalAccount('local-1', 'ext-1')],
        externalAccounts: [{ account_id: 'ext-1' }, { account_id: 'ext-2' }],
        upgradingAccountId: undefined,
        createNewOptionId: CREATE_NEW,
      });

    // ext-1 is already linked to local-1; ext-2 defaults to create-new
    expect(initiallyChosenAccounts['ext-1']).toBe('local-1');
    expect(initiallyChosenAccounts['ext-2']).toBe(CREATE_NEW);
    expect(initialDraftLinkAccounts.get('ext-1')).toBe('linking');
    expect(initialDraftLinkAccounts.get('ext-2')).toBe('linking');
  });

  it('does not preselect create-new in the upgrade flow', () => {
    const { initiallyChosenAccounts, initialDraftLinkAccounts } =
      getInitialAccountSelections({
        localAccounts: [makeLocalAccount('local-1', null)],
        externalAccounts: [{ account_id: 'ext-1' }, { account_id: 'ext-2' }],
        upgradingAccountId: 'local-1',
        createNewOptionId: CREATE_NEW,
      });

    // First unmatched external account is preselected for the upgrading
    // account (existing behavior); the rest stay unchosen.
    expect(initiallyChosenAccounts['ext-1']).toBe('local-1');
    expect(initiallyChosenAccounts['ext-2']).toBeUndefined();
    expect(initialDraftLinkAccounts.get('ext-1')).toBe('linking');
    expect(initialDraftLinkAccounts.get('ext-2')).toBeUndefined();
  });

  it('keeps already-linked accounts mapped to their local accounts', () => {
    const { initiallyChosenAccounts } = getInitialAccountSelections({
      localAccounts: [
        makeLocalAccount('local-1', 'ext-1'),
        makeLocalAccount('local-2', 'ext-2'),
      ],
      externalAccounts: [{ account_id: 'ext-1' }, { account_id: 'ext-2' }],
      upgradingAccountId: undefined,
      createNewOptionId: CREATE_NEW,
    });

    expect(initiallyChosenAccounts).toEqual({
      'ext-1': 'local-1',
      'ext-2': 'local-2',
    });
  });
});
