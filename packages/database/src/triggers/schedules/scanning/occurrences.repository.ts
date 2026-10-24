import { WorkflowAlreadyRunningError } from '../../../runs/commands/concurrency.js';
import { recordWorkflowTriggerSkip } from '../../skips.repository.js';
import type { InitialCheckpointFactory } from '../../../runs/commands/initial-checkpoint.js';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { generatePersistedId } from '../../../platform/persisted-id.js';

import {
  acceptWorkflowRun,
  WorkspaceRunQuotaExceededError,
} from '../../../runs/commands/acceptance.js';
import { parsePublishedWorkflowRow } from '../../../runs/queries/execution/published.js';
import { scheduleOccurrenceDisposition } from '../misfire.js';
import {
  parsePersistedScheduleRecurrence,
  resolveScheduleObservation,
} from '../recurrence.js';
import {
  claimedScheduleWorkflowPaused,
  type RecordedScheduleOccurrence,
} from '../pause.queries.js';
import {
  claimCleanupTimeoutMillis,
  retireInterruptedBatch,
  retireScheduleClaim,
} from '../retirement.repository.js';
import {
  withWorkspaceTransaction,
  type WorkspaceTransaction,
} from '../../../tenant-access/transactions.js';
import {
  ScheduleClaimLostError,
  type ScheduleClaim,
  type ScanDueInput,
  type ClaimOutcome,
  type ClaimedOccurrence,
  type ScannerResources,
} from './contract.js';
import { cancellationFailure } from './leases.repository.js';

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
    select id,workspace_id,workflow_id,version_number,checksum,
           executable_json
      from app.workflow_versions
     where workspace_id=${claim.workspace_id}
       and id=${claim.workflow_version_id}
  `);
  const published = parsePublishedWorkflowRow(version.rows[0]);
  if (published === null)
    throw new ScheduleClaimLostError('Schedule is no longer eligible');
  const initial = checkpointFactory(published);
  const identity = `${claim.trigger_id}:${scheduledAt.toISOString()}`;
  const result = await acceptWorkflowRun(transaction, {
    initialCheckpoint: initial.checkpoint,
    ...(initial.validateInput === undefined
      ? {}
      : { validateInput: initial.validateInput }),
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
  let disposition: RecordedScheduleOccurrence =
    (await claimedScheduleWorkflowPaused(
      transaction,
      claim,
      occurrence.scheduledAt,
    ))
      ? 'paused'
      : occurrence.disposition;
  let runId: string | null = null;
  let skipReason: 'concurrency_limit' | null = null;
  if (disposition === 'accepted') {
    await transaction.db.execute(sql`savepoint schedule_run_admission`);
    try {
      runId = await admitScheduledRun(
        transaction,
        claim,
        occurrence.scheduledAt,
        checkpointFactory,
      );
    } catch (error) {
      if (!(error instanceof WorkflowAlreadyRunningError)) throw error;
      await transaction.db.execute(
        sql`rollback to savepoint schedule_run_admission`,
      );
      disposition = 'skipped';
      skipReason = 'concurrency_limit';
    }
    await transaction.db.execute(sql`release savepoint schedule_run_admission`);
  }
  // Record the occurrence once, move the schedule on and release the lease.
  const schedule = await transaction.db.execute(sql`
    select 1 from app.trigger_schedules
    where trigger_id=${claim.trigger_id} and lease_token=${claim.lease_token}
      and lease_expires_at>clock_timestamp()
    for update`);
  if (schedule.rows.length !== 1)
    throw new ScheduleClaimLostError('Schedule claim expired');
  const recorded = await transaction.db.execute(sql`
    insert into app.trigger_schedule_occurrences
      (id, workspace_id, trigger_id, scheduled_at, disposition, workflow_run_id, skip_reason)
    values (${generatePersistedId()}, ${transaction.workspaceId},
            ${claim.trigger_id}, ${occurrence.scheduledAt}, ${disposition},
            ${runId},${skipReason})
    on conflict (trigger_id, scheduled_at) do nothing returning id`);
  if (skipReason !== null && recorded.rows.length === 1)
    await recordWorkflowTriggerSkip(transaction, claim.workflow_id, 'schedule');
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

export async function processScheduleClaim(
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
