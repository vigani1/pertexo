import type { InitialCheckpointFactory } from '../../runs/initial-checkpoint.js';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { z } from 'zod';

import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import type { DatabaseConfig } from '../../config.js';
import {
  acceptWorkflowRun,
  WorkspaceRunQuotaExceededError,
} from '../../runs/commands/acceptance.js';
import { classifyPublishedWorkflowVersionRow } from '../../runs/published-workflow.js';
import {
  scheduleOccurrenceDisposition,
  type ScheduleOccurrenceDisposition,
} from './misfire.js';
import {
  parsePersistedScheduleRecurrence,
  resolveScheduleObservation,
} from './recurrence.js';
import {
  claimedScheduleWorkflowPaused,
  type RecordedScheduleOccurrence,
} from './pause.js';
import {
  claimCleanupTimeoutMillis,
  retireInterruptedBatch,
  retireScheduleClaim,
} from './claim-retirement.js';
import {
  withPlatformTransaction,
  withWorkspaceTransaction,
  type WorkspaceTransaction,
} from '../../tenant-access/transactions.js';

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

export type ScanDueSchedulesResult = Readonly<{
  claimed: number;
  accepted: number;
  skipped: number;
  paused: number;
  deferred: number;
  maxLagSeconds: number;
}>;

export interface ScheduleTriggerScanner {
  scanDue(
    input: Readonly<{
      leaseOwner: string;
      limit: number;
      leaseSeconds: number;
      /**
       * ADR 049: how late, from 60 through 3,600 seconds, a `skip` schedule's
       * greatest due occurrence may be observed and still be admitted.
       */
      onTimeWindowSeconds: number;
      checkpointFactory: InitialCheckpointFactory;
      signal?: AbortSignal;
    }>,
  ): Promise<ScanDueSchedulesResult>;
  close(): Promise<void>;
}

export class ScheduleClaimLostError extends Error {
  public override readonly name = 'ScheduleClaimLostError';
}

type ScheduleClaim = z.output<typeof claimSchema>;
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
type ClaimOutcome = RecordedScheduleOccurrence | 'deferred';
type ClaimedOccurrence = Readonly<{
  disposition: ScheduleOccurrenceDisposition;
  nextAt: Date;
  scheduledAt: Date;
}>;
type ScannerResources = Readonly<{
  acceptancePool: Pool;
  claimPool: Pool;
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

/**
 * Whether the claim still holds its lease and its trigger, workflow and
 * workspace are still active on the trigger's published version.
 */
export async function isScheduleClaimEligible(
  transaction: WorkspaceTransaction,
  claim: Readonly<{ trigger_id: string; lease_token: string }>,
): Promise<boolean> {
  const eligible = await transaction.db.execute(sql`
    select 1 from app.trigger_schedules schedule
    join app.workflow_triggers trigger on trigger.id=schedule.trigger_id
    join app.workflows workflow on workflow.id=trigger.workflow_id
    join app.workspaces workspace on workspace.id=trigger.workspace_id
    where schedule.trigger_id=${claim.trigger_id}
      and schedule.lease_token=${claim.lease_token}
      and schedule.lease_expires_at>clock_timestamp()
      and schedule.status='enabled' and trigger.status='active'
      and workflow.lifecycle_status='active'
      and workflow.activation_status in ('active','degraded')
      and workflow.published_version_id=trigger.workflow_version_id
      and workspace.status='active'`);
  return eligible.rows.length === 1;
}

/**
 * The single admission path for an admitted occurrence under either misfire
 * policy: lease eligibility, the published version and idempotent acceptance keyed by trigger and scheduled instant.
 */
async function admitScheduledRun(
  transaction: WorkspaceTransaction,
  claim: ScheduleClaim,
  scheduledAt: Date,
  checkpointFactory: InitialCheckpointFactory,
): Promise<string> {
  if (!(await isScheduleClaimEligible(transaction, claim)))
    throw new ScheduleClaimLostError('Schedule is no longer eligible');
  const version = await transaction.db.execute(sql<Record<string, unknown>>`
    select id,workspace_id,workflow_id,version_number,schema_version,checksum,
           executable_schema_version,executable_json
      from app.workflow_versions
     where workspace_id=${claim.workspace_id}
       and id=${claim.workflow_version_id}
  `);
  const classified = classifyPublishedWorkflowVersionRow(version.rows[0]);
  if (classified.kind !== 'v2_projection')
    throw new ScheduleClaimLostError('Schedule is no longer eligible');
  const initial = checkpointFactory(classified.workflowVersion);
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
  return result.runId;
}

async function persistClaimedOccurrence(
  transaction: WorkspaceTransaction,
  claim: ScheduleClaim,
  occurrence: ClaimedOccurrence,
  checkpointFactory: InitialCheckpointFactory,
): Promise<RecordedScheduleOccurrence> {
  const disposition: RecordedScheduleOccurrence =
    (await claimedScheduleWorkflowPaused(
      transaction,
      claim,
      occurrence.scheduledAt,
    ))
      ? 'paused'
      : occurrence.disposition;
  const runId =
    disposition === 'accepted'
      ? await admitScheduledRun(
          transaction,
          claim,
          occurrence.scheduledAt,
          checkpointFactory,
        )
      : null;
  // Record the occurrence once, move the schedule on and release the lease.
  const schedule = await transaction.db.execute(sql`
    select 1 from app.trigger_schedules
    where trigger_id=${claim.trigger_id} and lease_token=${claim.lease_token}
      and lease_expires_at>clock_timestamp()
    for update`);
  if (schedule.rows.length !== 1)
    throw new ScheduleClaimLostError('Schedule claim expired');
  await transaction.db.execute(sql`
    insert into app.trigger_schedule_occurrences
      (id, workspace_id, trigger_id, scheduled_at, disposition, workflow_run_id)
    values (${generatePersistedId()}, ${transaction.workspaceId},
            ${claim.trigger_id}, ${occurrence.scheduledAt}, ${disposition},
            ${runId})
    on conflict (trigger_id, scheduled_at) do nothing`);
  await transaction.db.execute(sql`
    update app.trigger_schedules
    set last_fire_at=${occurrence.scheduledAt},
        next_fire_at=${occurrence.nextAt},
        lease_owner=null, lease_token=null, lease_acquired_at=null,
        lease_expires_at=null, admission_deferred_until=null,
        health_status='healthy', last_error_code=null,
        updated_at=clock_timestamp()
    where trigger_id=${claim.trigger_id} and lease_token=${claim.lease_token}`);
  await transaction.db.execute(sql`
    update app.workflow_triggers
    set health_status='healthy', last_error_code=null,
        updated_at=clock_timestamp()
    where id=${claim.trigger_id} and workspace_id=${transaction.workspaceId}`);
  return disposition;
}

async function processScheduleClaim(
  resources: ScannerResources,
  remainingClaims: readonly ScheduleClaim[],
  input: ScanDueInput,
  onTimeWindowSeconds: number,
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
  const occurrence: ClaimedOccurrence = Object.freeze({
    disposition: scheduleOccurrenceDisposition({
      misfirePolicy: claim.misfire_policy,
      scheduledAt: observation.greatestDueAt,
      observedAt: claim.observed_at,
      onTimeWindowSeconds,
    }),
    nextAt: observation.nextAt,
    scheduledAt: observation.greatestDueAt,
  });
  try {
    const recorded = await withWorkspaceTransaction(
      resources.acceptancePool,
      claim.workspace_id,
      (transaction) =>
        persistClaimedOccurrence(
          transaction,
          claim,
          occurrence,
          input.checkpointFactory,
        ),
      input.signal === undefined ? {} : { signal: input.signal },
    );
    return Object.freeze({ kind: recorded, lagSeconds });
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
  const onTimeWindowSeconds = z
    .number()
    .int()
    .min(60)
    .max(3_600)
    .parse(input.onTimeWindowSeconds);
  const batch = await claimDueSchedules(resources.claimPool, input);
  const outcomes = { accepted: 0, deferred: 0, paused: 0, skipped: 0 };
  let maxLagSeconds = 0;
  for (const [index] of batch.claims.entries()) {
    const outcome = await processScheduleClaim(
      resources,
      batch.claims.slice(index),
      input,
      onTimeWindowSeconds,
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
  acceptanceConfig: DatabaseConfig,
  runtimes: Readonly<{
    acceptance?: DatabaseRuntime;
    claim?: DatabaseRuntime;
  }> = {},
): ScheduleTriggerScanner {
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
  });
  return Object.freeze({
    scanDue: (input: ScanDueInput) => scanDueSchedules(resources, input),
    close: () => closeScheduleScannerLeases(claimLease, acceptanceLease),
  });
}
