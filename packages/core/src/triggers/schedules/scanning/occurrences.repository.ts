import type { ScheduleRunInput } from '../../../shared/trigger-run-input.schemas.js';
import { admitInSavepoint } from '../../admission-savepoint.repository.js';
import { scheduleCanFire } from '../schedule-standing.js';
import { scheduleFailureReason } from '../../trigger-failure.js';
import { decodeStoredValue } from '../../../shared/stored-values.js';
import { WorkflowAlreadyRunningError } from '../../../runs/commands/acceptance/run-admission.errors.js';
import { recordWorkflowTriggerSkip } from '../../../runs/commands/acceptance/trigger-skips.repository.js';
import type { InitialCheckpointFactory } from '../../../runs/commands/initial-checkpoint.types.js';
import { createHash } from 'node:crypto';

import { acceptWorkflowRun } from '../../../runs/commands/acceptance/accept.js';
import { WorkspaceRunQuotaExceededError } from '../../../runs/commands/acceptance/run-admission.errors.js';
import { scheduleOccurrenceDisposition } from '../misfire.js';
import {
  parsePersistedScheduleRecurrence,
  resolveScheduleObservation,
} from '../recurrence.js';
import { claimedScheduleWorkflowPaused } from '../pause.repository.js';
import type { RecordedScheduleOccurrence } from '../schedule-occurrence.types.js';
import {
  CLAIM_CLEANUP_TIMEOUT_MILLIS,
  retireScheduleClaim,
} from '../retire.js';
import {
  withWorkspaceTransaction,
  type WorkspaceTransaction,
} from '@pertexo/database/primitives';
import {
  ScanInterruptedError,
  ScheduleClaimLostError,
} from '../schedule-trigger.errors.js';
import type {
  ClaimRetirement,
  ScheduleClaim,
  ScanDueInput,
  ClaimOutcome,
  ClaimedOccurrence,
  ScannerResources,
} from './schedule-scanning.types.js';
import { cancellationFailure } from './scan-failures.js';
import {
  advanceClaimedSchedule,
  insertOccurrence,
  lockLiveClaim,
  readClaimedVersion,
  readClaimStanding,
} from './claims.repository.js';

/**
 * Whether the claim still holds its lease and its trigger, workflow and
 * workspace are still active on the trigger's published version.
 */
export async function isScheduleClaimEligible(
  transaction: WorkspaceTransaction,
  claim: Readonly<{ trigger_id: string; lease_token: string }>,
): Promise<boolean> {
  const standing = await readClaimStanding(transaction, claim);
  return standing !== undefined && scheduleCanFire(standing);
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
  const published = await readClaimedVersion(transaction, claim);
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
    } satisfies ScheduleRunInput,
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
    const admission = await admitInSavepoint(
      transaction,
      'schedule_run_admission',
      () =>
        admitScheduledRun(
          transaction,
          claim,
          occurrence.scheduledAt,
          checkpointFactory,
        ),
      (error) => error instanceof WorkflowAlreadyRunningError,
    );
    if (admission.admitted) runId = admission.value;
    else {
      disposition = 'skipped';
      skipReason = 'concurrency_limit';
    }
  }
  // Record the occurrence once, move the schedule on and release the lease.
  const live = await lockLiveClaim(transaction, claim);
  if (!live) throw new ScheduleClaimLostError('Schedule claim expired');
  const recorded = await insertOccurrence(transaction, claim, {
    occurrence,
    disposition,
    runId,
    skipReason,
  });
  if (skipReason !== null && recorded)
    await recordWorkflowTriggerSkip(transaction, claim.workflow_id, 'schedule');
  await advanceClaimedSchedule(transaction, claim, occurrence);
  return disposition;
}

/** Failing to retire a claim stops the batch, reporting what led here if anything did. */
async function retireClaim(
  resources: ScannerResources,
  claim: ScheduleClaim,
  retirement: ClaimRetirement,
  ...failure: [] | [unknown]
): Promise<void> {
  try {
    await retireScheduleClaim(
      resources.claimPool,
      claim,
      retirement,
      AbortSignal.timeout(CLAIM_CLEANUP_TIMEOUT_MILLIS),
    );
  } catch (error: unknown) {
    throw new ScanInterruptedError(failure.length === 0 ? error : failure[0]);
  }
}

export async function processScheduleClaim(
  resources: ScannerResources,
  claim: ScheduleClaim,
  input: ScanDueInput,
  onTimeWindowSeconds: number,
): Promise<Readonly<{ kind: ClaimOutcome; lagSeconds: number }>> {
  const lagSeconds =
    (claim.observed_at.getTime() - claim.next_fire_at.getTime()) / 1_000;
  let observation: ReturnType<typeof resolveScheduleObservation>;
  try {
    observation = resolveScheduleObservation(
      decodeStoredValue(() => parsePersistedScheduleRecurrence(claim)),
      claim.anchor_at,
      claim.observed_at,
    );
  } catch (error: unknown) {
    await retireClaim(
      resources,
      claim,
      { kind: 'fail', reason: 'schedule.recurrence_invalid' },
      error,
    );
    throw error;
  }
  if (observation.greatestDueAt === null) {
    await retireClaim(resources, claim, { kind: 'release' });
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
      await retireClaim(resources, claim, { kind: 'release' }, aborted);
      throw new ScanInterruptedError(aborted);
    }
    if (error instanceof WorkspaceRunQuotaExceededError) {
      await retireClaim(
        resources,
        claim,
        { kind: 'defer', retryAfterSeconds: error.retryAfterSeconds },
        error,
      );
      return Object.freeze({ kind: 'deferred', lagSeconds });
    }
    await retireClaim(
      resources,
      claim,
      { kind: 'fail', reason: scheduleFailureReason(error) },
      error,
    );
    // Archived or lost to another worker since the claim: nothing went wrong.
    if (error instanceof ScheduleClaimLostError)
      return Object.freeze({ kind: 'deferred', lagSeconds });
    throw error;
  }
}
