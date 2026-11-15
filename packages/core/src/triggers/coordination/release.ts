import { decodeStoredValue } from '../../shared/stored-values.js';
import {
  findPendingEvent,
  readPendingWorkflow,
  lockPendingEvent,
  readOlderPendingEvent,
  readPendingEventWindow,
  readPendingEventVersion,
  readPendingEndpoint,
  deferPendingEvent,
  waitPendingEventForCapacity,
  restPendingEvent,
  type PendingEvent,
} from './pending.repository.js';
import {
  capacityRetryAt,
  failedReleaseRetryAt,
  throttledReleaseAt,
} from './release-timing.js';
import { admitInSavepoint } from '../admission-savepoint.repository.js';
import { lockWorkspaceRunAdmission } from '../../shared/workspace-fence.repository.js';
import { openWebhookResponse } from '../webhooks/responses/admission.repository.js';
import { createHash } from 'node:crypto';
import {
  decideEventCoordination,
  EVENT_COORDINATION_LIMITS,
  type EventCoordinationReason,
} from '@pertexo/workflow-model';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { acceptWorkflowRun } from '../../runs/commands/acceptance/accept.js';
import {
  WorkspaceRunQuotaExceededError,
  WorkspaceRunAdmissionDeniedError,
} from '../../runs/commands/acceptance/run-admission.errors.js';
import { WorkflowAlreadyRunningError } from '../../runs/commands/acceptance/run-admission.errors.js';
import type { InitialCheckpointFactory } from '../../runs/commands/initial-checkpoint.types.js';
import { parseStoredExecutionValue } from '../../shared/stored-execution.js';
import { recordWorkflowTriggerSkip } from '../../runs/commands/acceptance/trigger-skips.repository.js';
import { finishCoordinatedEvent } from './events.repository.js';
import { chargeEventWindow, lockEventCoordination } from './keys.repository.js';
import { readDatabaseClock } from '../../shared/database-clock.repository.js';

export async function releaseCoordinatedEvent(
  transaction: WorkspaceTransaction,
  id: string,
  checkpointFactory: InitialCheckpointFactory,
): Promise<'started' | 'pending' | 'refused' | 'idle'> {
  const locked = await lockCoordinatedEvent(transaction, id);
  if (locked === undefined) return 'idle';
  const { workspaceStatus, workflow, event } = locked;

  const workflowUnavailable =
    workspaceStatus !== 'active' ||
    workflow?.lifecycle_status !== 'active' ||
    workflow.trigger_pause_state !== 'none';
  if (workflowUnavailable)
    return refuseCoordinatedEvent(transaction, id, 'workflow_unavailable');
  if (workflow.published_version_id !== event.workflow_version_id)
    return refuseCoordinatedEvent(transaction, id, 'publication_changed');
  const endpoint = await checkPendingEventEndpoint(transaction, event);
  if (endpoint.kind === 'refused')
    return refuseCoordinatedEvent(transaction, id, 'endpoint_disabled');
  const { webhookTriggerId } = endpoint;
  const now = await readDatabaseClock(transaction.db);
  if (now >= event.deadline_at)
    return refuseCoordinatedEvent(transaction, id, 'coordination_timeout');
  if (
    event.capacity_wait_started_at !== null &&
    now.getTime() - event.capacity_wait_started_at.getTime() >=
      EVENT_COORDINATION_LIMITS.capacityWaitMillis
  )
    return refuseCoordinatedEvent(transaction, id, 'queue_full');
  if (event.due_at > now) return 'pending';
  const older = await readOlderPendingEvent(transaction, id, event.key_id);
  if (older.length > 0) return 'pending';
  const key = (await readPendingEventWindow(transaction, event.key_id))[0];
  if (key === undefined) throw new Error('Pending event window is unavailable');
  const decision = decideEventCoordination({
    policy: event.policy,
    now: now.getTime(),
    window: {
      startedAt: key.window_started_at.getTime(),
      used: key.used_count,
    },
    hasPending: false,
  });
  if (event.policy.mode === 'throttle' && decision.action !== 'start') {
    if (decision.dueAt === undefined)
      return refuseCoordinatedEvent(transaction, id, 'throttle_limit');
    await deferPendingEvent(
      transaction,
      id,
      throttledReleaseAt(decision.dueAt, event),
    );
    return 'pending';
  }
  return startPendingCoordinatedRun(transaction, id, {
    event,
    checkpointFactory,
    now,
    webhookTriggerId,
    decision,
  });
}

async function lockCoordinatedEvent(
  transaction: WorkspaceTransaction,
  id: string,
) {
  // Match every ingress: workspace admission, publication, then the pending row.
  const workspaceStatus = await lockWorkspaceRunAdmission(
    transaction.db,
    transaction.workspaceId,
  );
  await lockEventCoordination(transaction.workspaceId, transaction.db);
  const identity = (await findPendingEvent(transaction, id))[0];
  if (identity === undefined) return undefined;
  const workflow = (
    await readPendingWorkflow(transaction, identity.workflow_id)
  )[0];
  const event = (await lockPendingEvent(transaction, id))[0];
  if (event === undefined) return undefined;
  return { workspaceStatus, workflow, event };
}
async function refuseCoordinatedEvent(
  transaction: WorkspaceTransaction,
  id: string,
  reason: EventCoordinationReason,
): Promise<'refused'> {
  await finishCoordinatedEvent(transaction, id, {
    status: 'refused',
    reason,
  });
  return 'refused' as const;
}
async function startPendingCoordinatedRun(
  transaction: WorkspaceTransaction,
  id: string,
  {
    event,
    checkpointFactory,
    now,
    webhookTriggerId,
    decision,
  }: Readonly<{
    event: PendingEvent;
    checkpointFactory: InitialCheckpointFactory;
    now: Date;
    webhookTriggerId: string | undefined;
    decision: ReturnType<typeof decideEventCoordination>;
  }>,
): Promise<'started' | 'pending' | 'refused'> {
  const version = (
    await readPendingEventVersion(transaction, event.workflow_version_id)
  )[0];
  if (version === undefined)
    return refuseCoordinatedEvent(transaction, id, 'publication_changed');
  const projection = Object.freeze(version);
  const initial = checkpointFactory(projection);
  const stored = decodeStoredValue(() =>
    parseStoredExecutionValue(event.input_ref),
  );
  if (stored.kind !== 'inline')
    throw new Error('Pending event input is unavailable');
  const digest = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  const admission = await admitInSavepoint(
    transaction,
    'release_coordinated_run',
    () =>
      acceptWorkflowRun(transaction, {
        operation: 'workflow.run.accept',
        scope: `coordination:${event.workflow_id}:${event.node_id}`,
        keyHash: digest(id),
        requestHash: digest(`${id}:${event.workflow_version_id}`),
        workflowId: event.workflow_id,
        workflowVersionId: event.workflow_version_id,
        triggerType: event.source,
        runInput: stored.value,
        initialCheckpoint: initial.checkpoint,
        ...(initial.validateInput === undefined
          ? {}
          : { validateInput: initial.validateInput }),
        ...(event.started_by === null ? {} : { startedBy: event.started_by }),
      }),
    isExpectedAdmissionRefusal,
  );
  if (admission.admitted) {
    const accepted = admission.value;
    if (webhookTriggerId !== undefined)
      await openWebhookResponse(transaction, webhookTriggerId, accepted.runId);
    await chargeEventWindow(
      transaction,
      event.key_id,
      event.policy,
      decision.window,
    );
    await finishCoordinatedEvent(transaction, id, {
      status: 'started',
      reason: null,
      runId: accepted.runId,
    });
    return 'started';
  }
  const { error } = admission;
  if (error instanceof WorkflowAlreadyRunningError) {
    await recordWorkflowTriggerSkip(
      transaction,
      event.workflow_id,
      event.source,
    );
    await finishCoordinatedEvent(transaction, id, {
      status: 'skipped',
      reason: 'concurrency_limit',
    });
    return 'refused';
  }
  if (error instanceof WorkspaceRunAdmissionDeniedError)
    return refuseCoordinatedEvent(transaction, id, 'workflow_unavailable');
  if (!(error instanceof WorkspaceRunQuotaExceededError)) throw error;
  const waitStartedAt = event.capacity_wait_started_at ?? now;
  await waitPendingEventForCapacity(transaction, id, {
    dueAt: capacityRetryAt({
      now,
      retryAfterSeconds: error.retryAfterSeconds,
      event,
      waitStartedAt,
    }),
    capacityWaitStartedAt: waitStartedAt,
  });
  return 'pending';
}

/** A full workspace, a running workflow or a denied admission keep the event's story. */
function isExpectedAdmissionRefusal(error: unknown): boolean {
  return (
    error instanceof WorkspaceRunQuotaExceededError ||
    error instanceof WorkflowAlreadyRunningError ||
    error instanceof WorkspaceRunAdmissionDeniedError
  );
}

async function checkPendingEventEndpoint(
  transaction: WorkspaceTransaction,
  event: PendingEvent,
) {
  let webhookTriggerId: string | undefined;
  if (event.endpoint_id !== null) {
    const eligible = await readPendingEndpoint(transaction, event);
    if (eligible.length !== 1) return { kind: 'refused' } as const;
    webhookTriggerId = eligible[0]?.trigger_id;
  }

  return { kind: 'eligible', webhookTriggerId } as const;
}

/** A failed release stays pending, but must let other discovery heads advance. */
export async function restFailedCoordinatedEvent(
  transaction: WorkspaceTransaction,
  id: string,
): Promise<void> {
  const locked = await lockCoordinatedEvent(transaction, id);
  if (locked === undefined) return;
  const now = await readDatabaseClock(transaction.db);
  if (locked.event.due_at > now) return;
  await restPendingEvent(
    transaction,
    id,
    failedReleaseRetryAt(now, locked.event),
  );
}
