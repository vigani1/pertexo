import { utf8ByteLength } from '@pertexo/workflow-model';
import { sql } from 'drizzle-orm';
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
  await transaction.db.execute(sql`
    insert into app.trigger_coordinated_events(id,workspace_id,workflow_id,node_id,source,mode,initial_outcome,initial_status,status,reason,run_id,version_number,finished_at,key_id,workflow_version_id,endpoint_id,policy,input_ref,input_bytes,due_at,deadline_at,started_by)
    values(${input.eventId},${transaction.workspaceId},${input.workflowId},${input.nodeId},${input.source},${input.prepared.policy.mode},${state.outcome},${state.status},${state.status},${state.reason ?? null},${state.runId ?? null},${input.version.versionNumber},case when ${state.status}='pending' then null else clock_timestamp() end,${state.pending?.keyId ?? null},${state.pending === undefined ? null : input.version.id},${state.pending === undefined ? null : (input.endpointId ?? null)},${state.pending === undefined ? null : JSON.stringify(input.prepared.policy)}::jsonb,${ref}::json,${raw === undefined ? 0 : utf8ByteLength(raw)},${state.pending?.dueAt ?? null},${state.pending?.deadlineAt ?? null},${state.pending === undefined ? null : (input.startedBy ?? null)})
  `);
  await transaction.db.execute(sql`
    insert into app.usage_events(id,workspace_id,category,quantity,resource_type,resource_id,idempotency_key,metadata)
    values(${input.eventId},${transaction.workspaceId},'trigger.coordinated',1,'workflow',${input.workflowId},${`coordinated:${input.eventId}`},${JSON.stringify({ nodeId: input.nodeId, source: input.source, mode: input.prepared.policy.mode, outcome: state.outcome })}::jsonb)
  `);
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
  await transaction.db.execute(sql`
    update app.trigger_coordinated_events set status=${status},reason=${reason},run_id=${runId ?? null},finished_at=clock_timestamp(),key_id=null,workflow_version_id=null,endpoint_id=null,policy=null,input_ref=null,input_bytes=0,due_at=null,deadline_at=null,capacity_wait_started_at=null,started_by=null where workspace_id=${transaction.workspaceId} and id=${id} and status='pending'
  `);
}
export function coordinatedReceipt(
  eventId: string,
  outcome: EventCoordinationReceipt['outcome'],
  status: EventCoordinationReceipt['status'],
  reason: EventCoordinationReason | null = null,
): EventCoordinationReceipt {
  return { coordinated: true, eventId, outcome, status, reason };
}
