import { decodeStoredValue } from '../../../shared/stored-values.js';
import type { Pool } from 'pg';
import { releaseClaims } from '../retire.js';
import type { ScanDueInput, ScheduleClaim } from './schedule-scanning.types.js';
import { claimSchema } from './schedule-claim.schemas.js';
import { claimDueScheduleRows } from './claims.repository.js';

/** Claims due schedules; one claim that does not parse releases the rest and fails the batch. */
export async function claimDueSchedules(
  claimPool: Pool,
  input: ScanDueInput,
): Promise<Readonly<{ claimed: number; claims: readonly ScheduleClaim[] }>> {
  input.signal?.throwIfAborted();
  const result = await claimDueScheduleRows(claimPool, input);
  const claims: ScheduleClaim[] = [];
  let invalidClaim: Error | undefined;
  for (const raw of result) {
    const parsed = claimSchema.safeParse(raw);
    if (parsed.success) claims.push(parsed.data);
    else invalidClaim ??= parsed.error;
  }
  if (invalidClaim !== undefined) {
    await releaseClaims(claimPool, claims);
    decodeStoredValue(() => {
      throw invalidClaim;
    });
  }
  return Object.freeze({
    claimed: result.length,
    claims: Object.freeze(claims),
  });
}
