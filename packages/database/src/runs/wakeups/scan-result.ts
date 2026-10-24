import { CoordinatorRunStateCorruptError } from '../state-errors.js';

export function parseClaimedWakeups(
  rows: readonly Readonly<{ claimed: unknown }>[],
  limit: number,
): number {
  const claimed = rows.length === 1 ? rows[0]?.claimed : undefined;
  const invalidClaimCount =
    typeof claimed !== 'number' ||
    !Number.isSafeInteger(claimed) ||
    claimed < 0 ||
    claimed > limit;
  if (invalidClaimCount) throw new CoordinatorRunStateCorruptError();
  return claimed;
}
