import type { BankSyncProviders } from '#types/models/bank-sync';

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
