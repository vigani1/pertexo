import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import type { acquireDatabasePool } from '@pertexo/database/platform';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { triggerSchedules } from '@pertexo/database/schema';

import { withPlatformTransaction } from '@pertexo/database/platform';
import { retireInterruptedBatch } from '../retirement.repository.js';
import type { ScanDueInput, ScheduleClaim } from './contract.js';
import { claimSchema } from './input.js';

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
  const leaseOwner = input.leaseOwner;
  const limit = input.limit;
  const leaseSeconds = input.leaseSeconds;
  input.signal?.throwIfAborted();
  const result = await withPlatformTransaction(
    claimPool,
    (client) =>
      drizzle(client)
        .select({
          trigger_id: sql<string>`claim.trigger_id`,
          workspace_id: sql<string>`claim.workspace_id`,
          workflow_id: sql<string>`claim.workflow_id`,
          workflow_version_id: sql<string>`claim.workflow_version_id`,
          node_id: sql<string>`claim.node_id`,
          recurrence_kind: sql<'cron' | 'interval'>`claim.recurrence_kind`,
          cron_expression: sql<string | null>`claim.cron_expression`,
          timezone: sql<string | null>`claim.timezone`,
          interval_minutes: sql<number | null>`claim.interval_minutes`,
          misfire_policy: sql<'catch_up_once' | 'skip'>`claim.misfire_policy`,
          config_fingerprint: sql<string>`claim.config_fingerprint`,
          anchor_at: sql<Date>`claim.anchor_at`.mapWith(
            triggerSchedules.anchorAt,
          ),
          next_fire_at: sql<Date>`claim.next_fire_at`.mapWith(
            triggerSchedules.nextFireAt,
          ),
          lease_token: sql<string>`claim.lease_token`,
          observed_at: sql<Date>`claim.observed_at`.mapWith(
            triggerSchedules.createdAt,
          ),
        })
        .from(
          sql`app.claim_due_trigger_schedules(${leaseOwner},${limit},${leaseSeconds}) as claim`,
        )
        .catch(rethrowQueryFailure),

    input.signal === undefined ? {} : { signal: input.signal },
  );
  const claims: ScheduleClaim[] = [];
  let invalidClaim: Error | undefined;
  for (const raw of result) {
    const parsed = claimSchema.safeParse(raw);
    if (parsed.success) claims.push(parsed.data);
    else invalidClaim ??= parsed.error;
  }
  if (invalidClaim !== undefined) {
    await retireInterruptedBatch(claimPool, claims, { kind: 'release' });
    throw invalidClaim;
  }
  return Object.freeze({
    claimed: result.length,
    claims: Object.freeze(claims),
  });
}
