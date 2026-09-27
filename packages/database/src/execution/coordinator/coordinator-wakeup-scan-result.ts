import { CoordinatorRunStateCorruptError } from './coordinator-run-store-contract.js';

export function parseClaimedWakeups(
  rows: readonly Readonly<{ claimed: unknown }>[],
  limit: number,
): number {
  const claimed = rows.length === 1 ? rows[0]?.claimed : undefined;
  if (
    typeof claimed !== 'number' ||
    !Number.isSafeInteger(claimed) ||
    claimed < 0 ||
    claimed > limit
  )
    throw new CoordinatorRunStateCorruptError();
  return claimed;
}
