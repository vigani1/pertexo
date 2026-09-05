import { generatePersistedId } from '../platform/persisted-id.js';

import type { PoolClient } from 'pg';

import {
  CoordinatorPlanInvalidError,
  CoordinatorRunStateCorruptError,
} from './coordinator-run-store-contract.js';
import type { PendingCoordinatorFailure } from './coordinator-run-store-commit-state.js';
import { terminalStatus } from './coordinator-run-store-observations.js';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';
import { canonicalOutboxPayloadChecksum } from './outbox.js';
import { serializeStoredExecutionJsonValue } from './stored-execution-value.js';

export type CoordinatorExecutionIdentity = Readonly<{
  nodeRunId: string;
  attemptId?: string;
  attemptNumber?: number;
}>;

type ExecutionIdentityMap = Map<string, CoordinatorExecutionIdentity>;

async function persistPendingFailureDecisions(
  client: PoolClient,
  plan: ParsedTransitionPlan,
  pendingFailures: readonly PendingCoordinatorFailure[],
  workspaceId: string,
  runId: string,
): Promise<void> {
  const invocations = new Map(
    plan.checkpoint.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  const decisionEvents = new Map(
    plan.events.flatMap((event) =>
      event.invocationKey !== undefined &&
      [
        'node.retry_scheduled',
        'node.failed',
        'node.canceled',
        'node.timed_out',
        'node.outcome_unknown',
      ].includes(event.name)
        ? [[event.invocationKey, event] as const]
        : [],
    ),
  );
  for (const failure of pendingFailures) {
    const event = decisionEvents.get(failure.invocation_key);
    if (event === undefined || !invocations.has(failure.invocation_key))
      throw new CoordinatorPlanInvalidError();
    const decision =
      event.name === 'node.retry_scheduled'
        ? 'retry'
        : event.name.slice('node.'.length);
    if (
      !['retry', 'failed', 'canceled', 'timed_out', 'outcome_unknown'].includes(
        decision,
      )
    )
      throw new CoordinatorPlanInvalidError();
    const finalized = await client.query(
      `update app.node_attempts
         set retry_decision=$3,updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2 and retry_decision='pending'`,
      [workspaceId, failure.attempt_id, decision],
    );
    if (finalized.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
    const nodeStatus = decision === 'retry' ? 'waiting' : decision;
    const updated = await client.query(
      `update app.node_runs
         set status=$4::varchar,retry_due_at=$5,resume_at=null,
             wait_kind=case when $4::varchar='waiting'
               then 'retry_backoff' else null end,
             due_wakeup_at=null,
             completed_at=case when $4::varchar='waiting'
               then null else clock_timestamp() end,
             safe_error_code=$6,updated_at=clock_timestamp()
         where workspace_id=$1 and workflow_run_id=$2
           and invocation_key=$3 and current_attempt_id=$7
           and status='running'`,
      [
        workspaceId,
        runId,
        failure.invocation_key,
        nodeStatus,
        decision === 'retry' ? event.dueAt : null,
        failure.safe_error_code,
        failure.attempt_id,
      ],
    );
    if (updated.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
  }
}

async function persistNodeAdmissions(
  client: PoolClient,
  plan: ParsedTransitionPlan,
  workspaceId: string,
  runId: string,
): Promise<ExecutionIdentityMap> {
  const invocations = new Map(
    plan.checkpoint.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  const attempts = new Map(
    plan.attempts.map((attempt) => [attempt.invocationKey, attempt]),
  );
  const physical: ExecutionIdentityMap = new Map();
  const rows: Readonly<Record<string, unknown>>[] = [];
  for (const admission of plan.nodeRunAdmissions) {
    const invocation = invocations.get(admission.invocationKey);
    if (invocation === undefined) throw new CoordinatorPlanInvalidError();
    const attempt = attempts.get(admission.invocationKey);
    const nodeRunId = generatePersistedId();
    const attemptId = attempt === undefined ? undefined : generatePersistedId();
    const status =
      invocation.status === 'pending'
        ? 'pending'
        : invocation.status === 'skipped'
          ? 'skipped'
          : 'ready';
    rows.push({
      id: nodeRunId,
      node_id: admission.nodeId,
      invocation_key: admission.invocationKey,
      branch_context: serializeStoredExecutionJsonValue({
        ...('branchPath' in invocation && invocation.branchPath !== undefined
          ? { branchPath: invocation.branchPath }
          : {}),
        ...('iterationPath' in invocation &&
        invocation.iterationPath !== undefined
          ? { iterationPath: invocation.iterationPath }
          : {}),
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

async function persistAttemptAdmissions(
  client: PoolClient,
  input: Readonly<{
    physical: ExecutionIdentityMap;
    plan: ParsedTransitionPlan;
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
      const existing = await client.query<{
        id: string;
        current_attempt_number: number | null;
        provider_idempotency_key: string | null;
        side_effect_class: string;
        status: string;
        is_due: boolean;
      }>(
        `select id, current_attempt_number, side_effect_class,
                provider_idempotency_key, status,
                coalesce(retry_due_at, resume_at) is not null
                  and coalesce(retry_due_at, resume_at) <= clock_timestamp()
                  as is_due
           from app.node_runs
           where workspace_id = $1 and workflow_run_id = $2
             and invocation_key = $3
           for update`,
        [workspaceId, runId, attempt.invocationKey],
      );
      const node = existing.rows[0];
      const isFirstReadyAttempt =
        (node?.status === 'ready' || node?.status === 'pending') &&
        (node.current_attempt_number === null
          ? attempt.attemptNumber === 1
          : node.current_attempt_number === attempt.attemptNumber - 1);
      const isDueAttempt =
        node?.status === 'waiting' &&
        node.is_due &&
        node.current_attempt_number === attempt.attemptNumber - 1;
      if (
        node?.side_effect_class !== attempt.sideEffectClass ||
        node.provider_idempotency_key !==
          (attempt.providerIdempotencyKey ?? null) ||
        (!isFirstReadyAttempt && !isDueAttempt)
      )
        throw new CoordinatorPlanInvalidError();
      ids = {
        nodeRunId: node.id,
        attemptId: generatePersistedId(),
        attemptNumber: attempt.attemptNumber,
      };
      physical.set(attempt.invocationKey, ids);
      await client.query(
        `update app.node_runs
           set status='ready', current_attempt_id=$1,
               current_attempt_number=$2, resume_at=null,
               retry_due_at=null, due_wakeup_at=null, wait_kind=null,
               updated_at=clock_timestamp()
           where workspace_id=$3 and id=$4`,
        [ids.attemptId, attempt.attemptNumber, workspaceId, ids.nodeRunId],
      );
    }
    if (ids.attemptId === undefined) throw new CoordinatorPlanInvalidError();
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
      schemaVersion: 1,
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
         id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,
         payload,payload_checksum)
       select item.id,$1,'execute-node-attempt',1,'node-attempt',
         item.aggregate_id,item.payload::jsonb,item.payload_checksum
       from jsonb_to_recordset($2::jsonb) as item(
         id uuid,aggregate_id uuid,payload text,payload_checksum char(64))`,
      [workspaceId, JSON.stringify(outboxRows)],
    );
    if (insertedOutbox.rowCount !== outboxRows.length)
      throw new CoordinatorRunStateCorruptError();
  }
}

async function loadEventExecutionIdentities(
  client: PoolClient,
  physical: ExecutionIdentityMap,
  plan: ParsedTransitionPlan,
  workspaceId: string,
  runId: string,
): Promise<void> {
  const missingInvocationKeys = [
    ...new Set(
      plan.events.flatMap(({ invocationKey }) =>
        invocationKey === undefined || physical.has(invocationKey)
          ? []
          : [invocationKey],
      ),
    ),
  ];
  if (missingInvocationKeys.length === 0) return;
  const existingNodes = await client.query<{
    id: string;
    invocation_key: string;
    current_attempt_id: string | null;
    current_attempt_number: number | null;
  }>(
    `select id, invocation_key, current_attempt_id,current_attempt_number
       from app.node_runs
       where workspace_id=$1 and workflow_run_id=$2
         and invocation_key=any($3::varchar[])
       for update`,
    [workspaceId, runId, missingInvocationKeys],
  );
  for (const node of existingNodes.rows)
    physical.set(node.invocation_key, {
      nodeRunId: node.id,
      ...(node.current_attempt_id === null
        ? {}
        : {
            attemptId: node.current_attempt_id,
            ...(node.current_attempt_number === null
              ? {}
              : { attemptNumber: node.current_attempt_number }),
          }),
    });
  if (missingInvocationKeys.some((key) => !physical.has(key)))
    throw new CoordinatorRunStateCorruptError();
}

async function persistRunEvents(
  client: PoolClient,
  input: Readonly<{
    pendingFailures: readonly PendingCoordinatorFailure[];
    physical: ExecutionIdentityMap;
    plan: ParsedTransitionPlan;
    runId: string;
    workspaceId: string;
  }>,
): Promise<void> {
  const { pendingFailures, physical, plan, runId, workspaceId } = input;
  const pendingFailureInvocations = new Set(
    pendingFailures.map(({ invocation_key: invocationKey }) => invocationKey),
  );
  const persistedEvents = plan.events.map((event) => {
    const ids =
      event.invocationKey === undefined
        ? undefined
        : physical.get(event.invocationKey);
    const payload = {
      schemaVersion: event.schemaVersion,
      ...(event.invocationKey === undefined
        ? {}
        : { invocationKey: event.invocationKey }),
      ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
      ...(event.attemptNumber === undefined
        ? {}
        : { attemptNumber: event.attemptNumber }),
      ...(event.reasonCode === undefined
        ? {}
        : { reasonCode: event.reasonCode }),
      ...(event.dueAt === undefined ? {} : { dueAt: event.dueAt }),
      ...(ids === undefined ? {} : { nodeRunId: ids.nodeRunId }),
      ...(ids?.attemptId !== undefined &&
      ids.attemptNumber === event.attemptNumber
        ? { attemptId: ids.attemptId }
        : {}),
    };
    return {
      sequence: event.sequence,
      type: event.name,
      payload: serializeStoredExecutionJsonValue(payload),
      created_at: event.occurredAt,
    };
  });
  if (persistedEvents.length > 0) {
    const inserted = await client.query(
      `insert into app.run_events (
         workspace_id,workflow_run_id,sequence,type,payload,created_at)
       select $1,$2,item.sequence,item.type,item.payload::jsonb,item.created_at
       from jsonb_to_recordset($3::jsonb) as item(
         sequence integer,type varchar(64),payload text,created_at timestamptz)`,
      [workspaceId, runId, JSON.stringify(persistedEvents)],
    );
    if (inserted.rowCount !== persistedEvents.length)
      throw new CoordinatorRunStateCorruptError();
  }
  for (const event of plan.events) {
    const terminalNodeStatus = terminalStatus(event.name);
    if (
      terminalNodeStatus !== undefined &&
      event.invocationKey !== undefined &&
      !pendingFailureInvocations.has(event.invocationKey)
    ) {
      const updatedNode = await client.query(
        `update app.node_runs
           set status=$1, completed_at=clock_timestamp(),
               safe_error_code=$2, resume_at=null, retry_due_at=null,
               due_wakeup_at=null, control_kind=null, wait_kind=null,
               updated_at=clock_timestamp()
           where workspace_id=$3 and workflow_run_id=$4
             and invocation_key=$5
             and status in ('pending','ready','waiting')`,
        [
          terminalNodeStatus,
          event.reasonCode ?? null,
          workspaceId,
          runId,
          event.invocationKey,
        ],
      );
      if (updatedNode.rowCount !== 1)
        throw new CoordinatorRunStateCorruptError();
    }
  }
}

export async function persistCoordinatorExecutionTransitions(
  client: PoolClient,
  input: Readonly<{
    pendingFailures: readonly PendingCoordinatorFailure[];
    plan: ParsedTransitionPlan;
    runId: string;
    traceparent?: string;
    workspaceId: string;
  }>,
): Promise<ReadonlyMap<string, CoordinatorExecutionIdentity>> {
  const { pendingFailures, plan, runId, traceparent, workspaceId } = input;
  await persistPendingFailureDecisions(
    client,
    plan,
    pendingFailures,
    workspaceId,
    runId,
  );
  const physical = await persistNodeAdmissions(
    client,
    plan,
    workspaceId,
    runId,
  );
  await persistAttemptAdmissions(client, {
    physical,
    plan,
    runId,
    ...(traceparent === undefined ? {} : { traceparent }),
    workspaceId,
  });
  await loadEventExecutionIdentities(
    client,
    physical,
    plan,
    workspaceId,
    runId,
  );
  await persistRunEvents(client, {
    pendingFailures,
    physical,
    plan,
    runId,
    workspaceId,
  });
  return physical;
}
