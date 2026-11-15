import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { EventCoordinationPolicy } from '@pertexo/workflow-model';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import {
  triggerCoordinatedEvents as events,
  triggerEventWindows as windows,
  workflows,
  workflowVersions,
  workflowTriggers,
  webhookTriggerEndpoints,
} from '@pertexo/database/schema';

export function findPendingEvent(
  transaction: WorkspaceTransaction,
  id: string,
) {
  return transaction.db
    .select({ workflow_id: events.workflowId })
    .from(events)
    .where(
      and(
        eq(events.workspaceId, transaction.workspaceId),
        eq(events.id, id),
        eq(events.status, 'pending'),
      ),
    );
}
export function readPendingWorkflow(
  transaction: WorkspaceTransaction,
  workflowId: string,
) {
  return transaction.db
    .select({
      published_version_id: workflows.publishedVersionId,
      lifecycle_status: workflows.lifecycleStatus,
      trigger_pause_state: workflows.triggerPauseState,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, transaction.workspaceId),
        eq(workflows.id, workflowId),
      ),
    )
    .for('share');
}
export function lockPendingEvent(
  transaction: WorkspaceTransaction,
  id: string,
) {
  // The pending-state constraint guarantees these execution fields are present.
  return transaction.db
    .select({
      id: events.id,
      workflow_id: events.workflowId,
      node_id: events.nodeId,
      source: sql<'webhook' | 'form'>`${events.source}`,
      workflow_version_id: sql<string>`${events.workflowVersionId}`,
      endpoint_id: events.endpointId,
      key_id: sql<string>`${events.keyId}`,
      policy: sql<EventCoordinationPolicy>`${events.policy}`,
      input_ref: events.inputRef,
      started_by: events.startedBy,
      due_at: sql<Date>`${events.dueAt}`.mapWith(events.dueAt),
      deadline_at: sql<Date>`${events.deadlineAt}`.mapWith(events.deadlineAt),
      capacity_wait_started_at: events.capacityWaitStartedAt,
    })
    .from(events)
    .where(
      and(
        eq(events.workspaceId, transaction.workspaceId),
        eq(events.id, id),
        eq(events.status, 'pending'),
      ),
    )
    .for('update', { skipLocked: true });
}
export type PendingEvent = Awaited<ReturnType<typeof lockPendingEvent>>[number];

export function readOlderPendingEvent(
  transaction: WorkspaceTransaction,
  id: string,
  keyId: string,
) {
  const current = alias(events, 'current');
  const position = transaction.db
    .select({ at: current.receivedAt, id: current.id })
    .from(current)
    .where(
      and(eq(current.workspaceId, transaction.workspaceId), eq(current.id, id)),
    );
  return transaction.db
    .select({ one: sql`1` })
    .from(events)
    .where(
      and(
        eq(events.workspaceId, transaction.workspaceId),
        eq(events.keyId, keyId),
        eq(events.status, 'pending'),
        sql`(${events.receivedAt},${events.id})<${position}`,
      ),
    )
    .limit(1);
}
export function readPendingEventWindow(
  transaction: WorkspaceTransaction,
  keyId: string,
) {
  return transaction.db
    .select({
      window_started_at: windows.windowStartedAt,
      used_count: windows.usedCount,
    })
    .from(windows)
    .where(
      and(
        eq(windows.workspaceId, transaction.workspaceId),
        eq(windows.id, keyId),
      ),
    )
    .for('update');
}
export function readPendingEventVersion(
  transaction: WorkspaceTransaction,
  versionId: string,
) {
  return transaction.db
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
        eq(workflowVersions.workspaceId, transaction.workspaceId),
        eq(workflowVersions.id, versionId),
      ),
    );
}
export function readPendingEndpoint(
  transaction: WorkspaceTransaction,
  event: PendingEvent,
) {
  const endpoint = alias(webhookTriggerEndpoints, 'endpoint');
  const trigger = alias(workflowTriggers, 'trigger');
  return transaction.db
    .select({ trigger_id: trigger.id })
    .from(endpoint)
    .innerJoin(
      trigger,
      and(
        eq(trigger.workspaceId, endpoint.workspaceId),
        eq(trigger.workflowId, endpoint.workflowId),
        eq(trigger.nodeId, endpoint.nodeId),
        eq(trigger.workflowVersionId, event.workflow_version_id),
      ),
    )
    .where(
      and(
        eq(endpoint.workspaceId, transaction.workspaceId),
        eq(endpoint.id, sql`${event.endpoint_id}`),
        eq(endpoint.status, 'active'),
      ),
    )
    .for('share', { of: [endpoint] });
}

/** Moves a held event's next try to `dueAt`. */
export async function deferPendingEvent(
  transaction: WorkspaceTransaction,
  id: string,
  dueAt: Date,
): Promise<void> {
  await transaction.db
    .update(events)
    .set({ dueAt })
    .where(
      and(eq(events.workspaceId, transaction.workspaceId), eq(events.id, id)),
    );
}

/** A held event waits for workspace capacity, from when it first had to. */
export async function waitPendingEventForCapacity(
  transaction: WorkspaceTransaction,
  id: string,
  wait: Readonly<{ dueAt: Date; capacityWaitStartedAt: Date }>,
): Promise<void> {
  await transaction.db
    .update(events)
    .set({
      reason: 'queue_full',
      dueAt: wait.dueAt,
      capacityWaitStartedAt: wait.capacityWaitStartedAt,
    })
    .where(
      and(eq(events.workspaceId, transaction.workspaceId), eq(events.id, id)),
    );
}

/** A failed release rests the still-pending event until `dueAt`. */
export async function restPendingEvent(
  transaction: WorkspaceTransaction,
  id: string,
  dueAt: Date,
): Promise<void> {
  await transaction.db
    .update(events)
    .set({ dueAt, reason: 'release_failed' })
    .where(
      and(
        eq(events.workspaceId, transaction.workspaceId),
        eq(events.id, id),
        eq(events.status, 'pending'),
      ),
    );
}

/** The key's oldest pending event, locked; a new event replaces or joins it. */
export async function lockOldestPendingEvent(
  transaction: WorkspaceTransaction,
  keyId: string,
) {
  const [pending] = await transaction.db
    .select({
      id: events.id,
      input_bytes: events.inputBytes,
      deadline_at: events.deadlineAt,
    })
    .from(events)
    .where(
      and(
        eq(events.workspaceId, transaction.workspaceId),
        eq(events.keyId, keyId),
        eq(events.status, 'pending'),
      ),
    )
    .orderBy(events.receivedAt, events.id)
    .limit(1)
    .for('update');
  return pending;
}

/** How many events, and how many input bytes, the workspace holds pending. */
export async function readPendingEventBudget(
  transaction: WorkspaceTransaction,
) {
  const [budget] = await transaction.db
    .select({
      count: sql<number>`count(*)::integer`,
      bytes: sql<number>`coalesce(sum(${events.inputBytes}),0)::integer`,
    })
    .from(events)
    .where(
      and(
        eq(events.workspaceId, transaction.workspaceId),
        eq(events.status, 'pending'),
      ),
    );
  return budget;
}
