import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { z } from 'zod';

import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../platform/database-runtime.js';
import { generatePersistedId } from '../platform/persisted-id.js';
import type { DatabaseConfig } from '../config.js';
import {
  lockExpectedCompatibilityReleaseSet,
  parseCompatibilityReleaseExpectation,
  parseCompatibilityReleaseExpectationSet,
  type CompatibilityReleaseExpectation,
  type CompatibilityReleaseExpectationSet,
} from '../compatibility/compatibility-release.js';
import {
  acceptWorkflowRun,
  WorkspaceRunQuotaExceededError,
} from '../execution/execution-acceptance.js';
import {
  classifyPublishedWorkflowVersionRow,
  type PublishedWorkflowV2Projection,
} from '../execution/published-workflow-reader.js';
import {
  parsePersistedScheduleRecurrence,
  resolveScheduleObservation,
} from './schedule-recurrence.js';
import {
  withPlatformTransaction,
  withWorkspaceTransaction,
  type WorkspaceTransaction,
} from '../tenant-access/workspace.js';

const claimSchema = z.object({
  trigger_id: z.uuid(),
  workspace_id: z.uuid(),
  workflow_id: z.uuid(),
  workflow_version_id: z.uuid(),
  node_id: z.string(),
  recurrence_kind: z.enum(['cron', 'interval']),
  cron_expression: z.string().nullable(),
  timezone: z.string().nullable(),
  interval_minutes: z.number().int().nullable(),
  misfire_policy: z.enum(['catch_up_once', 'skip']),
  config_fingerprint: z.string(),
  anchor_at: z.date(),
  next_fire_at: z.date(),
  lease_token: z.uuid(),
  observed_at: z.date(),
});

export type ScheduleCheckpointFactory = (
  projection: PublishedWorkflowV2Projection,
  currentCompatibilityRelease: CompatibilityReleaseExpectation,
) => Readonly<{ engineVersion: string; checkpoint: unknown }>;

export type ScanDueSchedulesResult = Readonly<{
  claimed: number;
  accepted: number;
  skipped: number;
  deferred: number;
  maxLagSeconds: number;
}>;

export interface ScheduleTriggerScanner {
  scanDue(
    input: Readonly<{
      leaseOwner: string;
      limit: number;
      leaseSeconds: number;
      checkpointFactory: ScheduleCheckpointFactory;
      signal?: AbortSignal;
    }>,
  ): Promise<ScanDueSchedulesResult>;
  close(): Promise<void>;
}

export class ScheduleClaimLostError extends Error {
  public override readonly name = 'ScheduleClaimLostError';
}

type ScheduleClaim = z.output<typeof claimSchema>;
type ClaimRetirement =
  | Readonly<{ kind: 'defer'; retryAfterSeconds: number }>
  | Readonly<{ kind: 'fail' | 'release' }>;

const claimCleanupTimeoutMillis = 5_000;

async function retireScheduleClaim(
  pool: Pool,
  claim: Pick<ScheduleClaim, 'lease_token' | 'trigger_id'>,
  retirement: ClaimRetirement,
  signal: AbortSignal,
): Promise<void> {
  await withPlatformTransaction(
    pool,
    async (client) => {
      if (retirement.kind === 'defer') {
        await client.query(
          'select app.defer_trigger_schedule_claim($1,$2,$3)',
          [claim.trigger_id, claim.lease_token, retirement.retryAfterSeconds],
        );
        return;
      }
      await client.query(
        retirement.kind === 'fail'
          ? 'select app.fail_trigger_schedule_claim($1,$2)'
          : 'select app.release_trigger_schedule_claim($1,$2)',
        [claim.trigger_id, claim.lease_token],
      );
    },
    { signal },
  );
}

/**
 * Retire the current claim according to its outcome and release every later
 * validated claim. Cleanup is bounded and diagnostic only: it cannot replace
 * the failure that interrupted the batch.
 */
async function retireInterruptedBatch(
  pool: Pool,
  claims: readonly ScheduleClaim[],
  first: ClaimRetirement,
): Promise<readonly unknown[]> {
  const signal = AbortSignal.timeout(claimCleanupTimeoutMillis);
  const failures: unknown[] = [];
  for (const [index, claim] of claims.entries()) {
    try {
      await retireScheduleClaim(
        pool,
        claim,
        index === 0 ? first : { kind: 'release' },
        signal,
      );
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  return Object.freeze(failures);
}

function throwableError(value: unknown, fallbackMessage: string): Error {
  return value instanceof Error
    ? value
    : new Error(fallbackMessage, { cause: value });
}

function cancellationFailure(
  signal: AbortSignal | undefined,
): Error | undefined {
  if (signal?.aborted !== true) return undefined;
  return throwableError(signal.reason, 'Schedule scan aborted');
}

async function closeScheduleScannerLeases(
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

type ScanDueInput = Parameters<ScheduleTriggerScanner['scanDue']>[0];
type ClaimOutcome = 'accepted' | 'deferred' | 'skipped';
type ScannerResources = Readonly<{
  acceptancePool: Pool;
  claimPool: Pool;
  compatibilityReleases: CompatibilityReleaseExpectationSet;
}>;

async function claimDueSchedules(
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

async function persistClaimedOccurrence(
  transaction: WorkspaceTransaction,
  claim: ScheduleClaim,
  observation: ReturnType<typeof resolveScheduleObservation>,
  compatibilityReleases: CompatibilityReleaseExpectationSet,
  checkpointFactory: ScheduleCheckpointFactory,
): Promise<void> {
  const scheduledAt = observation.greatestDueAt;
  if (scheduledAt === null)
    throw new Error('A claimed occurrence must have a scheduled instant');
  let runId: string | null = null;
  if (claim.misfire_policy === 'catch_up_once') {
    const eligible = await transaction.db.execute<{ eligible: boolean }>(sql`
      select app.schedule_claim_is_eligible(
        ${claim.trigger_id},${claim.lease_token}) eligible
    `);
    if (eligible.rows[0]?.eligible !== true)
      throw new ScheduleClaimLostError('Schedule is no longer eligible');
    const version = await transaction.db.execute(sql<Record<string, unknown>>`
      select id,workspace_id,workflow_id,version_number,schema_version,checksum,
             executable_schema_version,executable_json,compatibility_release_epoch
        from app.workflow_versions
       where workspace_id=${claim.workspace_id}
         and id=${claim.workflow_version_id}
    `);
    const classified = classifyPublishedWorkflowVersionRow(version.rows[0]);
    if (classified.kind !== 'v2_projection')
      throw new ScheduleClaimLostError('Schedule is no longer eligible');
    const currentCompatibilityRelease =
      await lockExpectedCompatibilityReleaseSet(
        transaction.db,
        compatibilityReleases,
      );
    const initial = checkpointFactory(
      classified.workflowVersion,
      currentCompatibilityRelease,
    );
    const identity = `${claim.trigger_id}:${scheduledAt.toISOString()}`;
    const result = await acceptWorkflowRun(transaction, {
      engineVersion: initial.engineVersion,
      initialCheckpoint: initial.checkpoint,
      keyHash: createHash('sha256').update(identity).digest('hex'),
      operation: 'workflow.run.accept',
      requestHash: createHash('sha256')
        .update(`${identity}:${claim.config_fingerprint}`)
        .digest('hex'),
      scope: `schedule:${claim.trigger_id}`,
      triggerType: 'schedule',
      workflowId: claim.workflow_id,
      workflowVersionId: claim.workflow_version_id,
      runInput: {
        schemaVersion: 1,
        triggerId: claim.trigger_id,
        nodeId: claim.node_id,
        scheduledAt: scheduledAt.toISOString(),
      },
    });
    runId = result.runId;
  }
  const completed = await transaction.db.execute<{ completed: boolean }>(sql`
    select app.complete_trigger_schedule_claim(
      ${claim.trigger_id},${claim.lease_token},${generatePersistedId()},${scheduledAt},
      ${claim.misfire_policy === 'skip' ? 'skipped' : 'accepted'},
      ${runId},${observation.nextAt}) completed
  `);
  if (completed.rows[0]?.completed !== true)
    throw new ScheduleClaimLostError('Schedule claim expired');
}

async function processScheduleClaim(
  resources: ScannerResources,
  remainingClaims: readonly ScheduleClaim[],
  input: ScanDueInput,
): Promise<Readonly<{ kind: ClaimOutcome; lagSeconds: number }>> {
  const claim = remainingClaims[0];
  if (claim === undefined) throw new Error('Schedule claim is unavailable');
  const cancellation = cancellationFailure(input.signal);
  if (cancellation !== undefined) {
    await retireInterruptedBatch(resources.claimPool, remainingClaims, {
      kind: 'release',
    });
    throw cancellation;
  }
  const lagSeconds =
    (claim.observed_at.getTime() - claim.next_fire_at.getTime()) / 1_000;
  let observation: ReturnType<typeof resolveScheduleObservation>;
  try {
    observation = resolveScheduleObservation(
      parsePersistedScheduleRecurrence(claim),
      claim.anchor_at,
      claim.observed_at,
    );
  } catch (error: unknown) {
    await retireInterruptedBatch(resources.claimPool, remainingClaims, {
      kind: 'fail',
    });
    throw error;
  }
  if (observation.greatestDueAt === null) {
    try {
      await retireScheduleClaim(
        resources.claimPool,
        claim,
        { kind: 'release' },
        AbortSignal.timeout(claimCleanupTimeoutMillis),
      );
    } catch (error: unknown) {
      await retireInterruptedBatch(
        resources.claimPool,
        remainingClaims.slice(1),
        { kind: 'release' },
      );
      throw error;
    }
    return Object.freeze({ kind: 'deferred', lagSeconds });
  }
  try {
    await withWorkspaceTransaction(
      resources.acceptancePool,
      claim.workspace_id,
      (transaction) =>
        persistClaimedOccurrence(
          transaction,
          claim,
          observation,
          resources.compatibilityReleases,
          input.checkpointFactory,
        ),
      input.signal === undefined ? {} : { signal: input.signal },
    );
    return Object.freeze({
      kind: claim.misfire_policy === 'skip' ? 'skipped' : 'accepted',
      lagSeconds,
    });
  } catch (error: unknown) {
    const aborted = cancellationFailure(input.signal);
    if (aborted !== undefined) {
      await retireInterruptedBatch(resources.claimPool, remainingClaims, {
        kind: 'release',
      });
      throw aborted;
    }
    if (error instanceof WorkspaceRunQuotaExceededError) {
      try {
        await retireScheduleClaim(
          resources.claimPool,
          claim,
          { kind: 'defer', retryAfterSeconds: error.retryAfterSeconds },
          AbortSignal.timeout(claimCleanupTimeoutMillis),
        );
      } catch {
        await retireInterruptedBatch(
          resources.claimPool,
          remainingClaims.slice(1),
          { kind: 'release' },
        );
        throw error;
      }
      return Object.freeze({ kind: 'deferred', lagSeconds });
    }
    await retireInterruptedBatch(resources.claimPool, remainingClaims, {
      kind: 'fail',
    });
    throw error;
  }
}

async function scanDueSchedules(
  resources: ScannerResources,
  input: ScanDueInput,
): Promise<ScanDueSchedulesResult> {
  const batch = await claimDueSchedules(resources.claimPool, input);
  const outcomes = { accepted: 0, deferred: 0, skipped: 0 };
  let maxLagSeconds = 0;
  for (const [index] of batch.claims.entries()) {
    const outcome = await processScheduleClaim(
      resources,
      batch.claims.slice(index),
      input,
    );
    outcomes[outcome.kind] += 1;
    maxLagSeconds = Math.max(maxLagSeconds, outcome.lagSeconds);
  }
  return Object.freeze({
    claimed: batch.claimed,
    ...outcomes,
    maxLagSeconds,
  });
}

export function createScheduleTriggerScanner(
  claimConfig: DatabaseConfig,
  compatibilityReleaseInput:
    CompatibilityReleaseExpectation | CompatibilityReleaseExpectationSet,
  acceptanceConfig: DatabaseConfig,
  runtimes: Readonly<{
    acceptance?: DatabaseRuntime;
    claim?: DatabaseRuntime;
  }> = {},
): ScheduleTriggerScanner {
  const compatibilityReleases = Array.isArray(compatibilityReleaseInput)
    ? parseCompatibilityReleaseExpectationSet(compatibilityReleaseInput)
    : Object.freeze([
        parseCompatibilityReleaseExpectation(compatibilityReleaseInput),
      ]);
  const claimLease = acquireDatabasePool(claimConfig, runtimes.claim);
  let acceptanceLease: ReturnType<typeof acquireDatabasePool>;
  try {
    acceptanceLease = acquireDatabasePool(
      acceptanceConfig,
      runtimes.acceptance,
    );
  } catch (error: unknown) {
    void claimLease.close().catch(() => undefined);
    throw error;
  }
  const resources: ScannerResources = Object.freeze({
    acceptancePool: acceptanceLease.pool,
    claimPool: claimLease.pool,
    compatibilityReleases,
  });
  return Object.freeze({
    scanDue: (input: ScanDueInput) => scanDueSchedules(resources, input),
    close: () => closeScheduleScannerLeases(claimLease, acceptanceLease),
  });
}
