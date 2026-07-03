# Mobile Bank-Sync UX — Design

**Date:** 2026-07-03
**Status:** Awaiting user review
**Scope:** Fork-only for now (TheDigitalImmigrant/actual), upstreamable later.

Two changes to how bank sync behaves for a household using Actual primarily from phones:

1. Allow setting up a bank connection from mobile without a pre-existing local account — discovered accounts are created with sensible defaults.
2. Stop importing pending transactions by default for TrueLayer-synced accounts, since pending can be cancelled without ever booking.

## Background

- The mobile bank-sync page (`packages/desktop-client/src/components/mobile/banksync/MobileBankSyncPage.tsx`) only lists existing accounts with a "link" action. The provider picker (`BuiltInProviders`, rendered by the desktop page `packages/desktop-client/src/components/banksync/index.tsx:101-106`) is unreachable on narrow screens. With zero accounts, the mobile page is a dead end ("you must first add an account").
- Everything downstream of the provider picker already works on mobile: `SelectLinkedAccountsModal` is responsive (narrow mode renders full-screen `AccountCard`s), offers "Create new account" / "Create new account (off budget)" options per discovered account, and the server-side link handlers (`packages/loot-core/src/server/accounts/app.ts`, incl. `linkTrueLayerAccount` at 554-637) already create accounts with good defaults (external account name / official name / mask, off-budget flag, transfer payee) when no `upgradingId` is given.
- The modal's initial selection (`SelectLinkedAccountsModal.tsx:178-213`) only pre-fills accounts that are *already linked* (matched by `account_id`) plus the upgrading account. Newly discovered accounts start with an empty choice, so the user must open an autocomplete per account and manually pick "Create new account" — clunky on a phone.
- Pending transactions: Actual has a per-account pref `sync-import-pending-<accountId>` (default **true**), enforced at `packages/loot-core/src/server/accounts/sync.ts:553` (`if (!importPending && !trans.cleared) continue;`). The checkbox UI exists on desktop (`banksync/BankSyncCheckboxOptions.tsx:180-185`) and mobile (`MobileBankSyncAccountEditPage.tsx`), reading defaults via `useBankSyncAccountSettings.ts`. Pending rows import as uncleared (`sync.ts:551`); the TrueLayer server's `startingBalance = current − sum(booked)` already excludes pending, so no balance rework is needed.

## Change 1: Create accounts from mobile bank-sync

### 1a. Provider connect on the mobile page

Add the built-in provider section to `MobileBankSyncPage`:

- Reuse `useBuiltInBankSyncProviders()` with **no** `upgradingAccountId` (same as the desktop page at `banksync/index.tsx:39`), rendered as a mobile-friendly list of providers with connect buttons.
- Replace the empty-state dead end with the same connect action, so a fresh budget can go bank-first.
- After provider auth, the existing flow takes over: `select-linked-accounts` modal → per-account choice → link/create. No changes to auth flows (`truelayer.ts`, GoCardless, Enable Banking handlers).

### 1b. Preselect "Create new account" for unmatched accounts

In `SelectLinkedAccountsModal.tsx`'s `initiallyChosenAccounts` memo (lines 178-213): any discovered external account that is not already linked and is not the upgrading target defaults to the `addOnBudgetAccountOption` ("Create new account") instead of empty, and is marked `'linking'` in `initialDraftLinkAccounts`.

- Applies on **both** desktop and mobile, but only in the fresh-connect flow (no `upgradingAccountId`) — in the upgrade flow, preselecting create-new for *other* discovered accounts would create accounts the user didn't ask for. Desktop users see a sensible default instead of an empty dropdown and can still change any row.
- Per-row control is unchanged: skip an account, mark it off-budget, or link to an existing local account before confirming.
- The existing "custom starting date/balance" options for new-account rows are untouched.

**Rejected alternatives:** fully-automatic creation after auth (no way to skip accounts or mark credit cards off-budget before creation); provider picker only with no preselect (keeps the per-account dropdown dance).

### Defaults used when creating

Already implemented server-side (per provider link handlers): name from the bank (`name` → `official_name` fallback, plus mask), on-budget unless the off-budget option is chosen, transfer payee created, initial sync kicked off with optional starting date/balance. No changes needed.

## Change 2: Pending transactions off by default (TrueLayer)

Flip the **default** of `sync-import-pending-<accountId>` to `false` when the account's `account_sync_source` is `'trueLayer'`:

- `packages/loot-core/src/server/accounts/sync.ts` (~533-537): where the pref is read with default `true`, default to `false` for trueLayer-synced accounts.
- `packages/desktop-client/src/components/banksync/useBankSyncAccountSettings.ts`: mirror the same default so the checkbox reflects reality.

The toggle remains fully functional — any account can opt back in. Other providers keep upstream behavior (default on), which keeps the fork diff minimal and upstream-friendly.

**Rejected alternatives:** hard-dropping pending server-side in `truelayer-service.ts` (kills the toggle, less flexible); flipping the default for all providers (needless upstream divergence); manually toggling the pref per account (new accounts would silently revert to importing pending).

### Knock-on effects (accepted)

- Accounts that never set the pref — including the existing linked accounts — pick up the new default immediately.
- Already-imported pending rows remain as uncleared transactions. When they settle, the booked version still fuzzy-matches the existing row in the database (`sync.ts` `matchTransactions`, ±7 days / same amount) and upgrades it in place. Genuinely cancelled pending rows will linger and need a one-time manual sweep after deploy.
- Account totals show booked-only until transactions settle, so they will read slightly behind the bank's own app (which shows pending). This is the requested behavior.

## Error handling

No new error paths. Provider auth errors on mobile surface exactly as they do on desktop (same hooks/modals). Account creation failures surface through the existing link-mutation error handling.

## Testing & verification

- `yarn typecheck` and existing unit suites (incl. the 21 TrueLayer server tests) stay green.
- Unit coverage where cheap: the preselection memo behavior (unmatched → create-new default) and the trueLayer-conditional `importPending` default.
- Manual end-to-end on a phone against the live deployment: connect TrueLayer from the mobile bank-sync page with no pre-existing account → review screen shows create-new preselected → link → accounts created, booked-only transactions imported.
- Rebuild `actual-truelayer:local` via `Dockerfile.local` and `docker compose up -d` to deploy.

## Delivery

Feature branch off `master` (fork), `[AI]`-prefixed commits, PR to fork master like the TrueLayer work.
