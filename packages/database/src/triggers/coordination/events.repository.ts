import { triggerCoordinatedEvents as events } from '../../schema/event-coordination/records.js';
import { usageEvents } from '../../schema/foundation.js';
import { utf8ByteLength } from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import type {
  EventCoordinationReceipt,
  EventCoordinationReason,
  EventCoordinationStatus,
} from '@pertexo/workflow-model';
import type { CoordinateEventInput } from './contract.js';

type EventState = Readonly<{
  outcome: 'accepted' | 'skipped' | EventCoordinationReceipt['outcome'];
  status: Exclude<EventCoordinationStatus, 'coalesced'>;
  reason?: EventCoordinationReason;
  runId?: string;
  pending?: Readonly<{ keyId: string; dueAt: Date; deadlineAt: Date }>;
}>;
export async function recordCoordinatedEvent(
  transaction: WorkspaceTransaction,
  input: CoordinateEventInput,
  state: EventState,
): Promise<void> {
  const raw =
    state.pending === undefined ? undefined : input.prepared.inputJson;
  const ref = raw === undefined ? null : `{"kind":"inline","value":${raw}}`;
  await transaction.db.insert(events).values({
    id: input.eventId,
    workspaceId: transaction.workspaceId,
    workflowId: input.workflowId,
    nodeId: input.nodeId,
    source: input.source,
    mode: input.prepared.policy.mode,
    initialOutcome: state.outcome,
    initialStatus: state.status,
    status: state.status,
    reason: state.reason ?? null,
    runId: state.runId ?? null,
    versionNumber: input.version.versionNumber,
    finishedAt: state.status === 'pending' ? null : sql`clock_timestamp()`,
    keyId: state.pending?.keyId ?? null,
    workflowVersionId: state.pending === undefined ? null : input.version.id,
    endpointId: state.pending === undefined ? null : (input.endpointId ?? null),
    policy: state.pending === undefined ? null : input.prepared.policy,
    inputRef: sql`${ref}::json`,
    inputBytes: raw === undefined ? 0 : utf8ByteLength(raw),
    dueAt: state.pending?.dueAt ?? null,
    deadlineAt: state.pending?.deadlineAt ?? null,
    startedBy: state.pending === undefined ? null : (input.startedBy ?? null),
  });
  await transaction.db.insert(usageEvents).values({
    id: input.eventId,
    workspaceId: transaction.workspaceId,
    category: 'trigger.coordinated',
    quantity: 1,
    resourceType: 'workflow',
    resourceId: input.workflowId,
    idempotencyKey: `coordinated:${input.eventId}`,
    metadata: {
      nodeId: input.nodeId,
      source: input.source,
      mode: input.prepared.policy.mode,
      outcome: state.outcome,
    },
  });
}
/** Terminal events retain metadata only; state references must not pin expired windows. */
export async function finishCoordinatedEvent(
  transaction: WorkspaceTransaction,
  id: string,
  {
    status,
    reason,
    runId,
  }: Readonly<{
    status: Exclude<EventCoordinationStatus, 'pending'>;
    reason: EventCoordinationReason | null;
    runId?: string | undefined;
  }>,
): Promise<void> {
  await transaction.db
    .update(events)
    .set({
      status,
      reason,
      runId: runId ?? null,
      finishedAt: sql`clock_timestamp()`,
      keyId: null,
      workflowVersionId: null,
      endpointId: null,
      policy: null,
      inputRef: null,
      inputBytes: 0,
      dueAt: null,
      deadlineAt: null,
      capacityWaitStartedAt: null,
      startedBy: null,
    })
    .where(
      and(
        eq(events.workspaceId, transaction.workspaceId),
        eq(events.id, id),
        eq(events.status, 'pending'),
      ),
    );
}
export function coordinatedReceipt(
  eventId: string,
  outcome: EventCoordinationReceipt['outcome'],
  status: EventCoordinationReceipt['status'],
  reason: EventCoordinationReason | null = null,
): EventCoordinationReceipt {
  return { coordinated: true, eventId, outcome, status, reason };
}
