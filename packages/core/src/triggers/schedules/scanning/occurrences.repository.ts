import {
  triggerSchedules as schedules,
  triggerScheduleOccurrences as occurrences,
  workflows,
  workflowVersions,
  workflowTriggers,
  workspaces,
} from '@pertexo/database/schema';
import { WorkflowAlreadyRunningError } from '../../../runs/commands/acceptance/errors.js';
import { recordWorkflowTriggerSkip } from '../../skips.repository.js';
import type { InitialCheckpointFactory } from '../../../runs/commands/initial-checkpoint.js';
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { generatePersistedId } from '@pertexo/database/platform';

import { acceptWorkflowRun } from '../../../runs/commands/acceptance.repository.js';
import { WorkspaceRunQuotaExceededError } from '../../../runs/commands/acceptance/errors.js';
import { scheduleOccurrenceDisposition } from '../misfire.js';
import {
  parsePersistedScheduleRecurrence,
  resolveScheduleObservation,
} from '../recurrence.js';
import { claimedScheduleWorkflowPaused } from '../pause.queries.js';
import type { RecordedScheduleOccurrence } from '../contract.js';
import {
  claimCleanupTimeoutMillis,
  retireInterruptedBatch,
  retireScheduleClaim,
} from '../retirement.repository.js';
import {
  withWorkspaceTransaction,
  type WorkspaceTransaction,
} from '@pertexo/database/primitives';
import { ScheduleClaimLostError } from '../errors.js';
import type {
  ScheduleClaim,
  ScanDueInput,
  ClaimOutcome,
  ClaimedOccurrence,
  ScannerResources,
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
  const eligible = await transaction.db
    .select({ one: sql`1` })
    .from(schedules)
    .innerJoin(workflowTriggers, eq(workflowTriggers.id, schedules.triggerId))
    .innerJoin(workflows, eq(workflows.id, workflowTriggers.workflowId))
    .innerJoin(workspaces, eq(workspaces.id, workflowTriggers.workspaceId))
    .where(
      and(
        eq(schedules.triggerId, claim.trigger_id),
        eq(schedules.leaseToken, claim.lease_token),
        sql`${schedules.leaseExpiresAt}>clock_timestamp()`,
        eq(schedules.status, 'enabled'),
        eq(workflowTriggers.status, 'active'),
        eq(workflows.lifecycleStatus, 'active'),
        inArray(workflows.activationStatus, ['active', 'degraded']),
        eq(workflows.publishedVersionId, workflowTriggers.workflowVersionId),
        eq(workspaces.status, 'active'),
      ),
    );
  return eligible.length === 1;
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
  const version = await transaction.db
    .select({
      id: workflowVersions.id,
      workspaceId: workflowVersions.workspaceId,
      workflowId: workflowVersions.workflowId,
      versionNumber: workflowVersions.versionNumber,
      checksum: workflowVersions.checksum,
      executableJson: workflowVersions.executableJson,
    })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workspaceId, claim.workspace_id),
        eq(workflowVersions.id, claim.workflow_version_id),
      ),
    );
  const published = version[0];
  if (published === undefined)
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
  const schedule = await transaction.db
    .select({ one: sql`1` })
    .from(schedules)
    .where(
      and(
        eq(schedules.triggerId, claim.trigger_id),
        eq(schedules.leaseToken, claim.lease_token),
        sql`${schedules.leaseExpiresAt}>clock_timestamp()`,
      ),
    )
    .for('update');
  if (schedule.length !== 1)
    throw new ScheduleClaimLostError('Schedule claim expired');
  const recorded = await transaction.db
    .insert(occurrences)
    .values({
      id: generatePersistedId(),
      workspaceId: transaction.workspaceId,
      triggerId: claim.trigger_id,
      scheduledAt: occurrence.scheduledAt,
      disposition,
      workflowRunId: runId,
      skipReason,
    })
    .onConflictDoNothing({
      target: [occurrences.triggerId, occurrences.scheduledAt],
    })
    .returning({ id: occurrences.id });
  if (skipReason !== null && recorded.length === 1)
    await recordWorkflowTriggerSkip(transaction, claim.workflow_id, 'schedule');
  await transaction.db
    .update(schedules)
    .set({
      lastFireAt: occurrence.scheduledAt,
      nextFireAt: occurrence.nextAt,
      leaseOwner: null,
      leaseToken: null,
      leaseAcquiredAt: null,
      leaseExpiresAt: null,
      admissionDeferredUntil: null,
      healthStatus: 'healthy',
      lastErrorCode: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedules.triggerId, claim.trigger_id),
        eq(schedules.leaseToken, claim.lease_token),
      ),
    );
  await transaction.db
    .update(workflowTriggers)
    .set({
      healthStatus: 'healthy',
      lastErrorCode: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workflowTriggers.id, claim.trigger_id),
        eq(workflowTriggers.workspaceId, transaction.workspaceId),
      ),
    );
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
