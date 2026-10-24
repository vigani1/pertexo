import { generatePersistedId } from '../../../../platform/persisted-id.js';
import type { PoolClient } from 'pg';
import { CoordinatorRunStateCorruptError } from '../../contract.js';

import type { RunTransitionPlan } from '../../plan.js';
import { canonicalOutboxPayloadChecksum } from '../../../../outbox/events.repository.js';
import { serializeStoredExecutionJsonValue } from '../../../../platform/stored-execution-value.js';
import type { ExecutionIdentityMap } from './contract.js';

export async function persistNodeAdmissions(
  client: PoolClient,
  plan: RunTransitionPlan,
  workspaceId: string,
  runId: string,
): Promise<ExecutionIdentityMap> {
  const invocations = new Map(
    [...plan.checkpoint.invocations, ...(plan.prunedInvocations ?? [])].map(
      (invocation) => [invocation.invocationKey, invocation],
    ),
  );
  const attempts = new Map(
    plan.attempts.map((attempt) => [attempt.invocationKey, attempt]),
  );
  const physical: ExecutionIdentityMap = new Map();
  const rows: Readonly<Record<string, unknown>>[] = [];
  for (const admission of plan.nodeRunAdmissions) {
    const invocation = invocations.get(admission.invocationKey);
    if (invocation === undefined) throw new CoordinatorRunStateCorruptError();
    const attempt = attempts.get(admission.invocationKey);
    const nodeRunId = generatePersistedId();
    const attemptId = attempt === undefined ? undefined : generatePersistedId();
    const status = admittedNodeStatus(invocation);
    rows.push({
      id: nodeRunId,
      node_id: admission.nodeId,
      invocation_key: admission.invocationKey,
      branch_context: serializeStoredExecutionJsonValue({
        ...(invocation.branchPath === undefined
          ? {}
          : { branchPath: invocation.branchPath }),
        ...(invocation.iterationPath === undefined
          ? {}
          : { iterationPath: invocation.iterationPath }),
      }),
      status,
      side_effect_class: admission.sideEffectClass,
      provider_idempotency_key: admission.providerIdempotencyKey ?? null,
      current_attempt_id: attemptId ?? null,
      current_attempt_number: attempt?.attemptNumber ?? null,
    });
    physical.set(admission.invocationKey, {
      nodeRunId,
      ...(attemptId === undefined || attempt === undefined
        ? {}
        : { attemptId, attemptNumber: attempt.attemptNumber }),
    });
  }
  if (rows.length > 0) {
    const inserted = await client.query(
      `insert into app.node_runs (
         id,workspace_id,workflow_run_id,node_id,invocation_key,
         branch_context,status,side_effect_class,provider_idempotency_key,
         current_attempt_id,current_attempt_number,completed_at)
       select item.id,$1,$2,item.node_id,item.invocation_key,
         item.branch_context::jsonb,item.status,item.side_effect_class,
         item.provider_idempotency_key,item.current_attempt_id,
         item.current_attempt_number,
         case when item.status='skipped' then clock_timestamp() else null end
       from jsonb_to_recordset($3::jsonb) as item(
         id uuid,node_id varchar(128),invocation_key varchar(256),
         branch_context text,status varchar(32),side_effect_class varchar(32),
         provider_idempotency_key varchar(256),current_attempt_id uuid,
         current_attempt_number integer)`,
      [workspaceId, runId, JSON.stringify(rows)],
    );
    if (inserted.rowCount !== rows.length)
      throw new CoordinatorRunStateCorruptError();
  }
  return physical;
}

export async function persistAttemptAdmissions(
  client: PoolClient,
  input: Readonly<{
    physical: ExecutionIdentityMap;
    plan: RunTransitionPlan;
    runId: string;
    traceparent?: string;
    workspaceId: string;
  }>,
): Promise<void> {
  const { physical, plan, runId, traceparent, workspaceId } = input;
  const attemptRows: Readonly<Record<string, unknown>>[] = [];
  const outboxRows: Readonly<Record<string, unknown>>[] = [];
  for (const attempt of plan.attempts) {
    let ids = physical.get(attempt.invocationKey);
    if (ids === undefined) {
      const existing = await client.query<{ id: string }>(
        `select id from app.node_runs
           where workspace_id = $1 and workflow_run_id = $2
             and invocation_key = $3
           for update`,
        [workspaceId, runId, attempt.invocationKey],
      );
      const node = existing.rows[0];
      if (node === undefined) throw new CoordinatorRunStateCorruptError();
      ids = {
        nodeRunId: node.id,
        attemptId: generatePersistedId(),
        attemptNumber: attempt.attemptNumber,
      };
      physical.set(attempt.invocationKey, ids);
      // A retry resolves and records its own input (ADR 052), so it starts
      // without its predecessor's. A resumed wait receives none: the input
      // its step received stays.
      await client.query(
        `update app.node_runs
           set status='ready', current_attempt_id=$1,
               current_attempt_number=$2, resume_at=null,
               retry_due_at=null, due_wakeup_at=null, wait_kind=null,
               input_ref=case when $5::boolean then input_ref end,
               updated_at=clock_timestamp()
           where workspace_id=$3 and id=$4`,
        [
          ids.attemptId,
          attempt.attemptNumber,
          workspaceId,
          ids.nodeRunId,
          attempt.admissionKind === 'wait_resume',
        ],
      );
    }
    if (ids.attemptId === undefined)
      throw new CoordinatorRunStateCorruptError();
    attemptRows.push({
      id: ids.attemptId,
      node_run_id: ids.nodeRunId,
      attempt_number: attempt.attemptNumber,
      side_effect_class: attempt.sideEffectClass,
      provider_idempotency_key: attempt.providerIdempotencyKey ?? null,
      admission_kind: attempt.admissionKind,
    });
    const outboxEventId = generatePersistedId();
    const payload = {
      workspaceId,
      runId,
      nodeRunId: ids.nodeRunId,
      attemptId: ids.attemptId,
      outboxEventId,
      ...(traceparent === undefined ? {} : { traceparent }),
    } as const;
    outboxRows.push({
      id: outboxEventId,
      aggregate_id: ids.attemptId,
      payload: serializeStoredExecutionJsonValue(payload),
      payload_checksum: canonicalOutboxPayloadChecksum(payload),
    });
  }
  if (attemptRows.length > 0) {
    const insertedAttempts = await client.query(
      `insert into app.node_attempts (
         id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
         provider_idempotency_key,admission_kind)
       select item.id,$1,item.node_run_id,item.attempt_number,'ready',
         item.side_effect_class,item.provider_idempotency_key,item.admission_kind
       from jsonb_to_recordset($2::jsonb) as item(
         id uuid,node_run_id uuid,attempt_number integer,
         side_effect_class varchar(32),provider_idempotency_key varchar(256),
         admission_kind varchar(32))`,
      [workspaceId, JSON.stringify(attemptRows)],
    );
    if (insertedAttempts.rowCount !== attemptRows.length)
      throw new CoordinatorRunStateCorruptError();
    const insertedOutbox = await client.query(
      `insert into app.outbox_events (
         id,workspace_id,job_name,aggregate_type,aggregate_id,
         payload,payload_checksum)
       select item.id,$1,'execute-node-attempt','node-attempt',
         item.aggregate_id,item.payload::jsonb,item.payload_checksum
        from jsonb_to_recordset($2::jsonb) as item(
         id uuid,aggregate_id uuid,payload text,payload_checksum char(64))`,
      [workspaceId, JSON.stringify(outboxRows)],
    );
    if (insertedOutbox.rowCount !== outboxRows.length)
      throw new CoordinatorRunStateCorruptError();
  }
}

function admittedNodeStatus(
  invocation: RunTransitionPlan['checkpoint']['invocations'][number],
): 'pending' | 'skipped' | 'ready' {
  if (invocation.status === 'pending') {
    return 'pending';
  }
  if (invocation.status === 'skipped') {
    return 'skipped';
  }
  return 'ready';
}
