import type { Pool } from 'pg';
import { z } from 'zod';
import type { acquireDatabasePool } from '../../../platform/pool/runtime.js';

import { retireInterruptedBatch } from '../retirement.repository.js';
import { withPlatformTransaction } from '../../../tenant-access/transactions.js';
import {
  claimSchema,
  type ScheduleClaim,
  type ScanDueInput,
} from './contract.js';

function throwableError(value: unknown, fallbackMessage: string): Error {
  return value instanceof Error
    ? value
    : new Error(fallbackMessage, { cause: value });
}

export function cancellationFailure(
  signal: AbortSignal | undefined,
): Error | undefined {
  if (!signal?.aborted) return undefined;
  return throwableError(signal.reason, 'Schedule scan aborted');
}

export async function closeScheduleScannerLeases(
  claimLease: ReturnType<typeof acquireDatabasePool>,
  acceptanceLease: ReturnType<typeof acquireDatabasePool>,
): Promise<void> {
  const settled = await Promise.allSettled([
    claimLease.close(),
    acceptanceLease.close(),
  ]);
  const failures: unknown[] = [];
  for (const result of settled)
    if (result.status === 'rejected') failures.push(result.reason);
  if (failures.length === 1)
    throw throwableError(failures[0], 'Schedule scanner close failed');
  if (failures.length > 1)
    throw new AggregateError(failures, 'Schedule scanner close failed');
}

export async function claimDueSchedules(
  claimPool: Pool,
  input: ScanDueInput,
): Promise<Readonly<{ claimed: number; claims: readonly ScheduleClaim[] }>> {
  const leaseOwner = z.string().min(1).max(128).parse(input.leaseOwner);
  const limit = z.number().int().min(1).max(100).parse(input.limit);
  const leaseSeconds = z
    .number()
    .int()
    .min(1)
    .max(300)
    .parse(input.leaseSeconds);
  input.signal?.throwIfAborted();
  const result = await withPlatformTransaction(
    claimPool,
    (client) =>
      client.query<Record<string, unknown>>(
        'select * from app.claim_due_trigger_schedules($1,$2,$3)',
        [leaseOwner, limit, leaseSeconds],
      ),
    input.signal === undefined ? {} : { signal: input.signal },
  );
  const claims: ScheduleClaim[] = [];
  let invalidClaim: Error | undefined;
  for (const raw of result.rows) {
    const parsed = claimSchema.safeParse(raw);
    if (parsed.success) claims.push(parsed.data);
    else invalidClaim ??= parsed.error;
  }
  if (invalidClaim !== undefined) {
    await retireInterruptedBatch(claimPool, claims, { kind: 'release' });
    throw invalidClaim;
  }
  return Object.freeze({
    claimed: result.rowCount ?? result.rows.length,
    claims: Object.freeze(claims),
  });
}
