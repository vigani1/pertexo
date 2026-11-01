import { triggerCoordinatedEvents as events } from '@pertexo/database/schema';
import {
  findPendingEvent,
  readPendingWorkflow,
  lockPendingEvent,
  readOlderPendingEvent,
  readPendingEventWindow,
  readPendingEventVersion,
  readPendingEndpoint,
  type PendingEvent,
} from './pending.queries.js';
import { openWebhookResponse } from '../webhooks/responses/admission.repository.js';
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  decideEventCoordination,
  EVENT_COORDINATION_LIMITS,
  type EventCoordinationReason,
} from '@pertexo/workflow-model';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { acceptWorkflowRun } from '../../runs/commands/acceptance.repository.js';
import {
  WorkspaceRunQuotaExceededError,
  WorkspaceRunAdmissionDeniedError,
} from '../../runs/commands/acceptance/errors.js';
import { WorkflowAlreadyRunningError } from '../../runs/commands/acceptance/errors.js';
import type { InitialCheckpointFactory } from '../../runs/commands/initial-checkpoint.js';
import { parseStoredExecutionValue } from '@pertexo/database/primitives';
import { recordWorkflowTriggerSkip } from '../skips.repository.js';
import { finishCoordinatedEvent } from './events.repository.js';
import {
  eventDatabaseTime,
  chargeEventWindow,
  lockEventCoordination,
} from './keys.repository.js';

export async function releaseCoordinatedEvent(
  transaction: WorkspaceTransaction,
  id: string,
  checkpointFactory: InitialCheckpointFactory,
): Promise<'started' | 'pending' | 'refused' | 'idle'> {
  const locked = await lockCoordinatedEvent(transaction, id);
  if (locked === undefined) return 'idle';
  const { workspace, workflow, event } = locked;

  const workflowUnavailable =
    workspace?.status !== 'active' ||
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
  const now = await eventDatabaseTime(transaction);
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
    await transaction.db
      .update(events)
      .set({
        dueAt: new Date(
          Math.min(
            decision.dueAt,
            event.deadline_at.getTime(),
            event.capacity_wait_started_at === null
              ? Infinity
              : event.capacity_wait_started_at.getTime() +
                  EVENT_COORDINATION_LIMITS.capacityWaitMillis,
          ),
        ),
      })
      .where(
        and(eq(events.workspaceId, transaction.workspaceId), eq(events.id, id)),
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
  const workspace = (
    await transaction.db.execute<{ status: string | null }>(
      sql`select app.lock_workspace_run_admission(${transaction.workspaceId}) status`,
    )
  ).rows[0];
  await lockEventCoordination(transaction.workspaceId, transaction.db);
  const identity = (await findPendingEvent(transaction, id))[0];
  if (identity === undefined) return undefined;
  const workflow = (
    await readPendingWorkflow(transaction, identity.workflow_id)
  )[0];
  const event = (await lockPendingEvent(transaction, id))[0];
  if (event === undefined) return undefined;
  return { workspace, workflow, event };
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
  const stored = parseStoredExecutionValue(event.input_ref);
  if (stored.kind !== 'inline')
    throw new Error('Pending event input is unavailable');
  const digest = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  await transaction.db.execute(sql`savepoint release_coordinated_run`);
  try {
    const accepted = await acceptWorkflowRun(transaction, {
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
    });
    await transaction.db.execute(
      sql`release savepoint release_coordinated_run`,
    );
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
  } catch (error) {
    const unexpectedAdmissionFailure =
      !(error instanceof WorkspaceRunQuotaExceededError) &&
      !(error instanceof WorkflowAlreadyRunningError) &&
      !(error instanceof WorkspaceRunAdmissionDeniedError);
    if (unexpectedAdmissionFailure) throw error;
    await transaction.db.execute(
      sql`rollback to savepoint release_coordinated_run`,
    );
    await transaction.db.execute(
      sql`release savepoint release_coordinated_run`,
    );
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
    const waitStartedAt = event.capacity_wait_started_at ?? now;
    await transaction.db
      .update(events)
      .set({
        reason: 'queue_full',
        dueAt: new Date(
          Math.min(
            now.getTime() + Math.min(5, error.retryAfterSeconds) * 1_000,
            event.deadline_at.getTime(),
            waitStartedAt.getTime() +
              EVENT_COORDINATION_LIMITS.capacityWaitMillis,
          ),
        ),
        capacityWaitStartedAt: waitStartedAt,
      })
      .where(
        and(eq(events.workspaceId, transaction.workspaceId), eq(events.id, id)),
      );
    return 'pending';
  }
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
