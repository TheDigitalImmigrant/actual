# Mobile Bank-Sync UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a phone user connect a bank from the mobile bank-sync page with accounts created automatically by default, and stop importing pending transactions by default on TrueLayer-synced accounts.

**Architecture:** Three small seams. (1) A shared pure helper `getDefaultImportPending(syncSource)` in loot-core gives both the loot-core import path and the desktop-client settings UI the same trueLayer-conditional default. (2) `SelectLinkedAccountsModal`'s initial-selection logic is extracted into an exported pure function and extended to preselect "Create new account" for unmatched external accounts in the fresh-connect flow. (3) `MobileBankSyncPage` gains the same `BuiltInProviders` section the desktop page renders, unlocking the whole existing downstream flow (auth → responsive modal → server-side account creation).

**Tech Stack:** TypeScript, React (desktop-client, React Compiler — no manual memoization needed), loot-core (vitest + real sqlite test db), yarn 4 workspaces run inside the `tl-dev` container.

**Spec:** `docs/superpowers/specs/2026-07-03-mobile-bank-sync-ux-design.md`

## Global Constraints

- All yarn commands run from repo root, inside the dev container: `docker exec tl-dev bash -lc 'cd /app && <command>'`.
- Every commit message MUST start with `[AI]` and end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- User-facing strings use `<Trans>`/`t()` (lint rule `actual/no-untranslated-strings`).
- New files must be TypeScript-strict — no `// @ts-strict-ignore` in new files.
- Grandfathered non-strict files (`sync.ts`, `SelectLinkedAccountsModal.tsx` has strict) keep their existing style; match surrounding code.
- Working branch: `feat/mobile-bank-sync-ux` in `/home/jarvis/projects/actual-src`.

---

### Task 1: Shared `getDefaultImportPending` helper

**Files:**
- Create: `packages/loot-core/src/shared/bank-sync.ts`
- Test: `packages/loot-core/src/shared/bank-sync.test.ts`

**Interfaces:**
- Produces: `getDefaultImportPending(syncSource: BankSyncProviders | null | undefined): boolean` — `false` for `'trueLayer'`, `true` otherwise. Tasks 2 and 3 import this.

- [ ] **Step 1: Write the failing test**

Create `packages/loot-core/src/shared/bank-sync.test.ts`:

```ts
import { getDefaultImportPending } from './bank-sync';

describe('getDefaultImportPending', () => {
  it('defaults to not importing pending for trueLayer accounts', () => {
    expect(getDefaultImportPending('trueLayer')).toBe(false);
  });

  it('defaults to importing pending for other providers', () => {
    expect(getDefaultImportPending('goCardless')).toBe(true);
    expect(getDefaultImportPending('simpleFin')).toBe(true);
    expect(getDefaultImportPending('enableBanking')).toBe(true);
  });

  it('defaults to importing pending when the sync source is unknown', () => {
    expect(getDefaultImportPending(null)).toBe(true);
    expect(getDefaultImportPending(undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec tl-dev bash -lc 'cd /app && yarn workspace @actual-app/core run test src/shared/bank-sync.test.ts'`
Expected: FAIL — cannot resolve `./bank-sync`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/loot-core/src/shared/bank-sync.ts`:

```ts
import type { BankSyncProviders } from '../types/models/bank-sync';

/**
 * Whether the `sync-import-pending-<accountId>` preference should be treated
 * as enabled when the user has never set it. TrueLayer pending transactions
 * can be cancelled by the bank without ever booking, so they are skipped
 * unless the user explicitly opts in.
 */
export function getDefaultImportPending(
  syncSource: BankSyncProviders | null | undefined,
): boolean {
  return syncSource !== 'trueLayer';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker exec tl-dev bash -lc 'cd /app && yarn workspace @actual-app/core run test src/shared/bank-sync.test.ts'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/loot-core/src/shared/bank-sync.ts packages/loot-core/src/shared/bank-sync.test.ts
git commit -m "[AI] Add shared default for the import-pending bank-sync pref

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: loot-core import path uses the trueLayer-conditional default

**Files:**
- Modify: `packages/loot-core/src/server/accounts/sync.ts:524-543` (`normalizeBankSyncTransactions`)
- Test: `packages/loot-core/src/server/accounts/sync.test.ts` (append tests inside `describe('Account sync', ...)`)

**Interfaces:**
- Consumes: `getDefaultImportPending` from Task 1 (import as `#shared/bank-sync` — this file uses `#shared/...` aliases).
- Produces: no signature changes; behavior change only (pending rows skipped by default when the account's `account_sync_source` is `'trueLayer'`).

- [ ] **Step 1: Write the failing tests**

Append inside `describe('Account sync', ...)` in `packages/loot-core/src/server/accounts/sync.test.ts`. The existing `prepareDatabase()` helper creates a goCardless-agnostic account without `account_sync_source`, so create accounts inline (mirroring `prepareDatabase`, sync.test.ts:60-73):

```ts
  async function prepareSyncedAccount(syncSource) {
    const id = await db.insertAccount({
      id: `${syncSource}-acct`,
      account_id: `${syncSource}-ext-1`,
      name: `${syncSource} account`,
      account_sync_source: syncSource,
    });
    await db.insertPayee({
      id: 'transfer-' + id,
      name: '',
      transfer_acct: id,
    });
    return id;
  }

  test('bank sync skips pending transactions by default for trueLayer accounts', async () => {
    const acctId = await prepareSyncedAccount('trueLayer');

    await reconcileTransactions(
      acctId,
      [
        {
          transactionId: 'tl-booked-1',
          date: '2020-01-02',
          payeeName: 'Bakkerij',
          amount: -4133,
          booked: true,
        },
        {
          transactionId: 'tl-pending-1',
          date: '2020-01-03',
          payeeName: 'Kroger',
          amount: -5000,
          booked: false,
        },
      ],
      true, // isBankSyncAccount
      false, // strictIdChecking
    );

    const transactions = await getAllTransactions();
    expect(transactions.length).toBe(1);
    expect(transactions[0].amount).toBe(-4133);
    expect(transactions[0].cleared).toBe(1);
  });

  test('bank sync imports pending for trueLayer when the pref opts in', async () => {
    const acctId = await prepareSyncedAccount('trueLayer');
    const pendingKey =
      `sync-import-pending-${acctId}` satisfies keyof SyncedPrefs;
    await db.update('preferences', { id: pendingKey, value: 'true' });

    await reconcileTransactions(
      acctId,
      [
        {
          transactionId: 'tl-booked-1',
          date: '2020-01-02',
          payeeName: 'Bakkerij',
          amount: -4133,
          booked: true,
        },
        {
          transactionId: 'tl-pending-1',
          date: '2020-01-03',
          payeeName: 'Kroger',
          amount: -5000,
          booked: false,
        },
      ],
      true,
      false,
    );

    const transactions = await getAllTransactions();
    expect(transactions.length).toBe(2);
  });

  test('bank sync still imports pending by default for goCardless accounts', async () => {
    const acctId = await prepareSyncedAccount('goCardless');

    await reconcileTransactions(
      acctId,
      [
        {
          transactionId: 'gc-booked-1',
          date: '2020-01-02',
          payeeName: 'Bakkerij',
          amount: -4133,
          booked: true,
        },
        {
          transactionId: 'gc-pending-1',
          date: '2020-01-03',
          payeeName: 'Kroger',
          amount: -5000,
          booked: false,
        },
      ],
      true,
      false,
    );

    const transactions = await getAllTransactions();
    expect(transactions.length).toBe(2);
  });
```

Note: `db.update('preferences', ...)` follows the existing pattern at sync.test.ts:135-137. If the opt-in test fails because the preferences row doesn't exist yet (`db.update` requires an existing row), use `db.insertWithSchema`/`db.insert('preferences', { id: pendingKey, value: 'true' })` instead — check how the existing reimport-deleted test behaves first; it uses `db.update`, so mirror whatever works there.

- [ ] **Step 2: Run tests to verify the right ones fail**

Run: `docker exec tl-dev bash -lc 'cd /app && yarn workspace @actual-app/core run test src/server/accounts/sync.test.ts'`
Expected: the two new default-behavior tests FAIL (pending currently imports for trueLayer: 2 transactions instead of 1); the opt-in and goCardless tests PASS. All pre-existing tests PASS.

- [ ] **Step 3: Implement the conditional default**

In `packages/loot-core/src/server/accounts/sync.ts`, add the import (alphabetical with the other `#shared/` imports):

```ts
import { getDefaultImportPending } from '#shared/bank-sync';
```

Then in `normalizeBankSyncTransactions` (line 524), look up the account before the pref reads and use the helper as the fallback:

```ts
async function normalizeBankSyncTransactions(transactions, acctId) {
  const payeesToCreate = new Map();

  const account = await db.getAccount(acctId);
  const importPendingDefault = getDefaultImportPending(
    account?.account_sync_source,
  );

  const [customMappingsRaw, importPending, importNotes] = await Promise.all([
    aqlQuery(
      q('preferences')
        .filter({ id: `custom-sync-mappings-${acctId}` })
        .select('value'),
    ).then(data => data?.data?.[0]?.value),
    aqlQuery(
      q('preferences')
        .filter({ id: `sync-import-pending-${acctId}` })
        .select('value'),
    ).then(
      data =>
        String(data?.data?.[0]?.value ?? String(importPendingDefault)) ===
        'true',
    ),
    aqlQuery(
      q('preferences')
        .filter({ id: `sync-import-notes-${acctId}` })
        .select('value'),
    ).then(data => String(data?.data?.[0]?.value ?? 'true') === 'true'),
  ]);
```

(Only the `account`/`importPendingDefault` lines and the `sync-import-pending` `.then` fallback change; everything else stays as-is.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `docker exec tl-dev bash -lc 'cd /app && yarn workspace @actual-app/core run test src/server/accounts/sync.test.ts'`
Expected: PASS, including all pre-existing tests (no regressions to non-trueLayer behavior).

- [ ] **Step 5: Commit**

```bash
git add packages/loot-core/src/server/accounts/sync.ts packages/loot-core/src/server/accounts/sync.test.ts
git commit -m "[AI] Skip pending transactions by default for TrueLayer accounts

Pending TrueLayer transactions can be cancelled by the bank without ever
booking. The existing sync-import-pending-<id> pref still opts back in
per account; other providers keep their import-by-default behavior.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Settings UI reflects the same default

**Files:**
- Modify: `packages/desktop-client/src/components/banksync/useBankSyncAccountSettings.ts`

**Interfaces:**
- Consumes: `getDefaultImportPending` from Task 1, imported as `@actual-app/core/shared/bank-sync` (desktop-client already imports `@actual-app/core/shared/query` this way).
- Produces: unchanged hook API; the "Import pending transactions" checkbox now starts unchecked for trueLayer accounts with no saved pref.

- [ ] **Step 1: Implement the conditional default**

In `packages/desktop-client/src/components/banksync/useBankSyncAccountSettings.ts`:

Add imports:

```ts
import { getDefaultImportPending } from '@actual-app/core/shared/bank-sync';

import { useAccounts } from '#hooks/useAccounts';
```

(Keep import groups/order consistent with the file: `@actual-app/core/...` imports go with the existing ones at the top; `#hooks/useAccounts` joins `#hooks/useSyncedPref`.)

Inside `useBankSyncAccountSettings`, before the pref declarations, resolve the account and replace the hardcoded `true` default for the pending pref (line 26):

```ts
export function useBankSyncAccountSettings(accountId: string) {
  const { data: accounts = [] } = useAccounts();
  const account = accounts.find(a => a.id === accountId);
  const importPendingDefault = getDefaultImportPending(
    account?.account_sync_source,
  );

  const [savedMappings = mappingsToString(defaultMappings), setSavedMappings] =
    useSyncedPref(`custom-sync-mappings-${accountId}`);
  const [savedImportNotes = true, setSavedImportNotes] = useSyncedPref(
    `sync-import-notes-${accountId}`,
  );
  const [savedImportPending = importPendingDefault, setSavedImportPending] =
    useSyncedPref(`sync-import-pending-${accountId}`);
```

No other lines change — the downstream `String(savedImportPending) === 'true'` conversion (line 42) already handles a boolean default.

- [ ] **Step 2: Typecheck**

Run: `docker exec tl-dev bash -lc 'cd /app && yarn workspace @actual-app/web run typecheck'`
Expected: "All files passed".

- [ ] **Step 3: Commit**

```bash
git add packages/desktop-client/src/components/banksync/useBankSyncAccountSettings.ts
git commit -m "[AI] Reflect the trueLayer import-pending default in sync settings UI

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Preselect "Create new account" for unmatched external accounts

**Files:**
- Modify: `packages/desktop-client/src/components/modals/SelectLinkedAccountsModal.tsx:178-231`
- Test: create `packages/desktop-client/src/components/modals/SelectLinkedAccountsModal.test.ts`
- Modify: `docs/superpowers/specs/2026-07-03-mobile-bank-sync-ux-design.md` (one-line refinement, see Step 5)

**Interfaces:**
- Produces: exported pure function used by the component and the test:

```ts
export function getInitialAccountSelections({
  localAccounts,
  externalAccounts,
  upgradingAccountId,
  createNewOptionId,
}: {
  localAccounts: AccountEntity[];
  externalAccounts: Array<{ account_id: string }>;
  upgradingAccountId: string | undefined;
  createNewOptionId: string;
}): {
  initialDraftLinkAccounts: Map<string, 'linking' | 'unlinking'>;
  initiallyChosenAccounts: Record<string, string>;
}
```

**Behavior refinement locked here:** the create-new preselect applies only in the fresh-connect flow (`upgradingAccountId == null`). In the upgrade flow ("link this existing account"), preselecting create-new for *other* discovered accounts would surprise the user into creating accounts they didn't ask for; that flow keeps today's behavior.

- [ ] **Step 1: Write the failing test**

Create `packages/desktop-client/src/components/modals/SelectLinkedAccountsModal.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec tl-dev bash -lc 'cd /app && yarn workspace @actual-app/web run test src/components/modals/SelectLinkedAccountsModal.test.ts'`
Expected: FAIL — `getInitialAccountSelections` is not exported.

- [ ] **Step 3: Extract and extend the selection logic**

In `SelectLinkedAccountsModal.tsx`, add the exported pure function near `useAddBudgetAccountOptions` (after line 76, before the props type). Its body is the current memo logic (lines 178-213) plus the create-new fill:

```ts
export function getInitialAccountSelections({
  localAccounts,
  externalAccounts,
  upgradingAccountId,
  createNewOptionId,
}: {
  localAccounts: AccountEntity[];
  externalAccounts: Array<{ account_id: string }>;
  upgradingAccountId: string | undefined;
  createNewOptionId: string;
}): {
  initialDraftLinkAccounts: Map<string, 'linking' | 'unlinking'>;
  initiallyChosenAccounts: Record<string, string>;
} {
  const externalAccountIds = new Set(externalAccounts.map(a => a.account_id));
  const initialDraftLinkAccounts = new Map<string, 'linking' | 'unlinking'>();
  for (const acc of localAccounts) {
    if (acc.account_id && externalAccountIds.has(acc.account_id)) {
      initialDraftLinkAccounts.set(acc.account_id, 'linking');
    }
  }

  const initiallyChosenAccounts = Object.fromEntries(
    localAccounts
      .filter(acc => acc.account_id)
      .map(acc => [acc.account_id, acc.id]),
  );

  if (upgradingAccountId) {
    const preselectedExternalAccount = externalAccounts.find(
      account => initiallyChosenAccounts[account.account_id] == null,
    );

    if (
      preselectedExternalAccount &&
      !Object.values(initiallyChosenAccounts).includes(upgradingAccountId)
    ) {
      initiallyChosenAccounts[preselectedExternalAccount.account_id] =
        upgradingAccountId;
      initialDraftLinkAccounts.set(
        preselectedExternalAccount.account_id,
        'linking',
      );
    }
  } else {
    // Fresh-connect flow: default every unmatched external account to
    // "Create new account" so linking is one confirmation, not a
    // dropdown per account. The user can still change or clear any row.
    for (const externalAccount of externalAccounts) {
      if (initiallyChosenAccounts[externalAccount.account_id] == null) {
        initiallyChosenAccounts[externalAccount.account_id] =
          createNewOptionId;
        initialDraftLinkAccounts.set(externalAccount.account_id, 'linking');
      }
    }
  }

  return { initialDraftLinkAccounts, initiallyChosenAccounts };
}
```

Notes on fidelity to the old memo: the original guarded the upgrade preselect with `upgradingAccountId &&` — that's preserved by the `if (upgradingAccountId)` branch. The original computed `preselectedExternalAccount` from the *sorted* externals; the component passes the sorted array (below), so behavior is identical.

Then replace the component's memo (lines 178-219) with a call to the pure function. `useAddBudgetAccountOptions()` must move above the memo (it currently sits at line 230):

```ts
  const { addOnBudgetAccountOption, addOffBudgetAccountOption } =
    useAddBudgetAccountOptions();

  const { initialDraftLinkAccounts, initiallyChosenAccounts } = useMemo(
    () =>
      getInitialAccountSelections({
        localAccounts,
        externalAccounts: propsWithSortedExternalAccounts.externalAccounts,
        upgradingAccountId,
        createNewOptionId: addOnBudgetAccountOption.id,
      }),
    [
      localAccounts,
      propsWithSortedExternalAccounts.externalAccounts,
      upgradingAccountId,
      addOnBudgetAccountOption.id,
    ],
  );
```

Delete the now-duplicated line-230 `useAddBudgetAccountOptions()` call. The old memo's `externalAccounts` dep (raw prop) is gone — the pure function only uses the sorted array, which itself derives from the prop.

- [ ] **Step 4: Run test and typecheck to verify**

Run: `docker exec tl-dev bash -lc 'cd /app && yarn workspace @actual-app/web run test src/components/modals/SelectLinkedAccountsModal.test.ts && yarn workspace @actual-app/web run typecheck'`
Expected: 3 tests PASS; typecheck "All files passed".

- [ ] **Step 5: Update the spec with the upgrade-flow refinement**

In `docs/superpowers/specs/2026-07-03-mobile-bank-sync-ux-design.md`, section "1b. Preselect...", change the first bullet's scope sentence to record the refinement:

Replace:

```
- Applies on **both** desktop and mobile — one behavior everywhere; desktop users see a sensible default instead of an empty dropdown and can still change any row.
```

with:

```
- Applies on **both** desktop and mobile, but only in the fresh-connect flow (no `upgradingAccountId`) — in the upgrade flow, preselecting create-new for *other* discovered accounts would create accounts the user didn't ask for. Desktop users see a sensible default instead of an empty dropdown and can still change any row.
```

- [ ] **Step 6: Commit**

```bash
git add packages/desktop-client/src/components/modals/SelectLinkedAccountsModal.tsx packages/desktop-client/src/components/modals/SelectLinkedAccountsModal.test.ts docs/superpowers/specs/2026-07-03-mobile-bank-sync-ux-design.md
git commit -m "[AI] Preselect create-new for unmatched accounts when linking a bank

In the fresh-connect flow every discovered external account without an
existing match now defaults to 'Create new account', so linking is one
confirmation instead of a dropdown per account. The upgrade flow keeps
its existing single-account preselect.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Provider connect section on the mobile bank-sync page

**Files:**
- Modify: `packages/desktop-client/src/components/mobile/banksync/MobileBankSyncPage.tsx`

**Interfaces:**
- Consumes: `BuiltInProviders` and `useBuiltInBankSyncProviders` from `#components/banksync/...` (same usage as the desktop page `banksync/index.tsx:34-39,101-106`; the hook is called with no arguments so there is no `upgradingAccountId` and the downstream modal enters the fresh-connect flow from Task 4).

- [ ] **Step 1: Add the providers section and fix the empty state**

In `MobileBankSyncPage.tsx`:

Add imports (into the existing `#components/banksync/...` import group):

```ts
import { BuiltInProviders } from '#components/banksync/BuiltInProviders';
import { useBuiltInBankSyncProviders } from '#components/banksync/useBuiltInBankSyncProviders';
```

In the component body, after the `useAccounts()` line:

```ts
  const {
    providers,
    syncServerStatus,
    showPermissionWarning,
    providersNeedingConfiguration,
  } = useBuiltInBankSyncProviders();
```

In the JSX, insert the providers section between the search `View` (ends line 117) and the `openAccounts.length === 0` conditional, and replace the dead-end empty-state copy:

```tsx
      <View
        style={{
          padding: 16,
          borderBottomWidth: 2,
          borderBottomStyle: 'solid',
          borderBottomColor: theme.tableBorder,
        }}
      >
        <BuiltInProviders
          providers={providers}
          syncServerStatus={syncServerStatus}
          showPermissionWarning={showPermissionWarning}
          providersNeedingConfiguration={providersNeedingConfiguration}
        />
      </View>

      {openAccounts.length === 0 ? (
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 20,
            paddingTop: 40,
          }}
        >
          <Text
            style={{
              fontSize: 16,
              color: theme.pageTextSubdued,
              textAlign: 'center',
            }}
          >
            <Trans>
              No accounts are linked yet. Connect a bank above and your
              accounts will be created automatically.
            </Trans>
          </Text>
        </View>
      ) : (
```

(The `BankSyncAccountsList` branch is unchanged.)

- [ ] **Step 2: Typecheck**

Run: `docker exec tl-dev bash -lc 'cd /app && yarn workspace @actual-app/web run typecheck'`
Expected: "All files passed".

- [ ] **Step 3: Commit**

```bash
git add packages/desktop-client/src/components/mobile/banksync/MobileBankSyncPage.tsx
git commit -m "[AI] Add bank-sync provider connect to the mobile bank-sync page

The mobile page previously only listed existing accounts, so a bank
connection could not be started from a phone without a pre-created
local account. Render the same BuiltInProviders section as the desktop
page; the downstream auth flow and account-selection modal are already
responsive.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Release note, i18n, lint, full verification

**Files:**
- Create: `upcoming-release-notes/mobile-bank-sync-create-accounts.md`
- Possibly modified by tooling: i18n catalogs, formatting

- [ ] **Step 1: Write the release note**

Create `upcoming-release-notes/mobile-bank-sync-create-accounts.md` (check an existing file in that directory for the exact front-matter shape and mirror it):

```md
---
category: Enhancements
authors: [TheDigitalImmigrant]
---

Allow starting a bank-sync connection from the mobile bank-sync page, defaulting discovered accounts to “Create new account”, and skip pending transactions by default for TrueLayer accounts
```

- [ ] **Step 2: Regenerate i18n and run lint:fix**

Run: `docker exec tl-dev bash -lc 'cd /app && yarn generate:i18n && yarn lint:fix'`
Expected: exits 0; may reformat touched files and update translation catalogs — inspect `git status` and include only files related to this change (new `Trans` strings, formatting of files this branch touched).

- [ ] **Step 3: Full typecheck and test run**

Run: `docker exec tl-dev bash -lc 'cd /app && yarn workspace @actual-app/core run typecheck && yarn workspace @actual-app/web run typecheck && yarn workspace @actual-app/core run test && yarn workspace @actual-app/web run test'`
Expected: all pass (core suite was 564+ green before this branch).

- [ ] **Step 4: Commit**

```bash
git add upcoming-release-notes/mobile-bank-sync-create-accounts.md <i18n/format files from step 2>
git commit -m "[AI] Add release note for mobile bank-sync UX changes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Build, deploy, verify end-to-end

**Files:** none in-repo (build + live verification).

- [ ] **Step 1: Build the Docker image**

Run from `/home/jarvis/projects/actual-src`: `docker build -f Dockerfile.local -t actual-truelayer:local .` (~5 min; run in background and monitor).
Expected: image builds; `docker images actual-truelayer:local` shows a new ID.

- [ ] **Step 2: Deploy**

Run: `cd /home/jarvis/projects/actual-budget && docker compose up -d`
Expected: `actual-budget` container recreated on the new image, healthy within ~30s (`docker ps` shows healthy). This also brings the previously-merged upstream master into production — worth a quick glance at the app afterwards.

- [ ] **Step 3: User verification on a phone (manual)**

Ask the user to check, at https://spark-db39.tail461554.ts.net on a phone:
1. Settings → Bank Sync now shows the provider connect section on mobile.
2. Connecting a bank (or re-linking) lands in the account screen with "Create new account" preselected for new accounts.
3. Bank Sync → account → edit shows "Import pending transactions" unchecked for TrueLayer accounts.
4. After a sync, no new uncleared pending rows appear.

- [ ] **Step 4: One-time cleanup of lingering cancelled pending rows**

After the user confirms, sweep old pending rows that will never book: list uncleared bank-sync transactions per TrueLayer account (via a better-sqlite3 script in the container, or just eyeball in the UI since volumes are small) and let the user confirm deletions in the UI. Do not delete transactions without the user seeing the list first.

- [ ] **Step 5: Merge**

Push `feat/mobile-bank-sync-ux` to `fork`, open PR to fork `master` titled `[AI] Mobile bank-sync UX: create accounts on link, skip pending by default` with the PR template body unmodified, and merge after the user's sign-off.

---

## Self-Review

- **Spec coverage:** 1a (provider connect + empty state) → Task 5; 1b (preselect create-new) → Task 4; account-creation defaults → already server-side, no task needed (spec says so); change 2 loot-core default → Tasks 1-2; change 2 settings-UI default → Task 3; testing/verification → Tasks 6-7; release note → Task 6; deploy → Task 7. Covered.
- **Placeholder scan:** the Task 6 release-note front matter says "mirror an existing file" — that's a real check, not a placeholder; content is given. Task 2 includes a fallback instruction if `db.update` can't upsert — contingency, with the concrete alternative named. No TBDs.
- **Type consistency:** `getDefaultImportPending(BankSyncProviders | null | undefined)` matches `AccountEntity['account_sync_source']` (`AccountSyncSource = BankSyncProviders`, nullable) at both call sites. `getInitialAccountSelections` signature matches the test and the component call. `useBuiltInBankSyncProviders()` no-arg call matches the desktop page's usage.
