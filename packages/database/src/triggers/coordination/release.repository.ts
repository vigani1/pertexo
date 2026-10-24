import { openWebhookResponse } from '../webhooks/responses/admission.repository.js';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  decideEventCoordination,
  EVENT_COORDINATION_LIMITS,
  type EventCoordinationPolicy,
  type EventCoordinationReason,
} from '@pertexo/workflow-model';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import {
  acceptWorkflowRun,
  WorkspaceRunQuotaExceededError,
  WorkspaceRunAdmissionDeniedError,
} from '../../runs/commands/acceptance.js';
import { WorkflowAlreadyRunningError } from '../../runs/commands/concurrency.js';
import type { InitialCheckpointFactory } from '../../runs/commands/initial-checkpoint.js';
import { parsePublishedWorkflowRow } from '../../runs/queries/execution/published.js';
import { parseStoredExecutionValue } from '../../platform/stored-execution-value.js';
import { recordWorkflowTriggerSkip } from '../skips.repository.js';
import { finishCoordinatedEvent } from './events.repository.js';
import {
  eventDatabaseTime,
  chargeEventWindow,
  lockEventCoordination,
} from './keys.repository.js';

type PendingEvent = Readonly<{
  id: string;
  workflow_id: string;
  node_id: string;
  source: 'webhook' | 'form';
  workflow_version_id: string;
  endpoint_id: string | null;
  key_id: string;
  policy: EventCoordinationPolicy;
  input_ref: unknown;
  started_by: string | null;
  due_at: Date;
  deadline_at: Date;
  capacity_wait_started_at: Date | null;
}>;
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
  const older = await transaction.db.execute(
    sql`select 1 from app.trigger_coordinated_events where workspace_id=${transaction.workspaceId} and key_id=${event.key_id} and status='pending' and (received_at,id)<(select received_at,id from app.trigger_coordinated_events where workspace_id=${transaction.workspaceId} and id=${id}) limit 1`,
  );
  if (older.rows.length > 0) return 'pending';
  const key = (
    await transaction.db.execute<{
      window_started_at: string;
      used_count: number;
    }>(
      sql`select window_started_at,used_count from app.trigger_event_windows where workspace_id=${transaction.workspaceId} and id=${event.key_id} for update`,
    )
  ).rows[0];
  if (key === undefined) throw new Error('Pending event window is unavailable');
  const decision = decideEventCoordination({
    policy: event.policy,
    now: now.getTime(),
    window: {
      startedAt: new Date(key.window_started_at).getTime(),
      used: key.used_count,
    },
    hasPending: false,
  });
  if (event.policy.mode === 'throttle' && decision.action !== 'start') {
    if (decision.dueAt === undefined)
      return refuseCoordinatedEvent(transaction, id, 'throttle_limit');
    await transaction.db.execute(
      sql`update app.trigger_coordinated_events set due_at=${new Date(Math.min(decision.dueAt, event.deadline_at.getTime(), event.capacity_wait_started_at === null ? Infinity : event.capacity_wait_started_at.getTime() + EVENT_COORDINATION_LIMITS.capacityWaitMillis))} where workspace_id=${transaction.workspaceId} and id=${id}`,
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
  const identity = (
    await transaction.db.execute<{ workflow_id: string }>(
      sql`select workflow_id from app.trigger_coordinated_events where workspace_id=${transaction.workspaceId} and id=${id} and status='pending'`,
    )
  ).rows[0];
  if (identity === undefined) return undefined;
  const workflow = (
    await transaction.db.execute<{
      published_version_id: string | null;
      lifecycle_status: string;
      trigger_pause_state: string;
    }>(
      sql`select published_version_id,lifecycle_status,trigger_pause_state from app.workflows where workspace_id=${transaction.workspaceId} and id=${identity.workflow_id} for share`,
    )
  ).rows[0];
  const row = (
    await transaction.db.execute<
      Omit<
        PendingEvent,
        'due_at' | 'deadline_at' | 'capacity_wait_started_at'
      > & {
        due_at: string;
        deadline_at: string;
        capacity_wait_started_at: string | null;
      }
    >(
      sql`select * from app.trigger_coordinated_events where workspace_id=${transaction.workspaceId} and id=${id} and status='pending' for update skip locked`,
    )
  ).rows[0];
  if (row === undefined) return undefined;
  const event: PendingEvent = {
    ...row,
    due_at: new Date(row.due_at),
    deadline_at: new Date(row.deadline_at),
    capacity_wait_started_at:
      row.capacity_wait_started_at === null
        ? null
        : new Date(row.capacity_wait_started_at),
  };

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
    await transaction.db.execute(
      sql`select id,workspace_id,workflow_id,version_number,checksum,executable_json from app.workflow_versions where workspace_id=${transaction.workspaceId} and id=${event.workflow_version_id}`,
    )
  ).rows[0];
  const projection = parsePublishedWorkflowRow(version);
  if (projection === null)
    return refuseCoordinatedEvent(transaction, id, 'publication_changed');
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
    await transaction.db.execute(
      sql`update app.trigger_coordinated_events set reason='queue_full',due_at=${new Date(Math.min(now.getTime() + Math.min(5, error.retryAfterSeconds) * 1_000, event.deadline_at.getTime(), waitStartedAt.getTime() + EVENT_COORDINATION_LIMITS.capacityWaitMillis))},capacity_wait_started_at=${waitStartedAt} where workspace_id=${transaction.workspaceId} and id=${id}`,
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
    const eligible = await transaction.db.execute<{ trigger_id: string }>(
      sql`select trigger.id trigger_id from app.webhook_trigger_endpoints endpoint join app.workflow_triggers trigger on trigger.workspace_id=endpoint.workspace_id and trigger.id=endpoint.trigger_id where endpoint.workspace_id=${transaction.workspaceId} and endpoint.id=${event.endpoint_id} and endpoint.status='active' and trigger.status='active' and trigger.workflow_version_id=${event.workflow_version_id} for share of endpoint,trigger`,
    );
    if (eligible.rows.length !== 1) return { kind: 'refused' } as const;
    webhookTriggerId = eligible.rows[0]?.trigger_id;
  }

  return { kind: 'eligible', webhookTriggerId } as const;
}
