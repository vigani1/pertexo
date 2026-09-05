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
  for (const admission of plan.nodeRunAdmissions) {
    const invocation = invocations.get(admission.invocationKey);
    if (invocation === undefined) throw new CoordinatorPlanInvalidError();
    const attempt = attempts.get(admission.invocationKey);
    const nodeRunId = generatePersistedId();
    const attemptId = attempt === undefined ? undefined : generatePersistedId();
    await client.query(
      `insert into app.node_runs (
         id, workspace_id, workflow_run_id, node_id, invocation_key,
         branch_context, status, side_effect_class, provider_idempotency_key,
         current_attempt_id, current_attempt_number, completed_at
       ) values (
         $1,$2,$3,$4,$5,$6::jsonb,$7::varchar,$8,$9,$10,$11,
         case when $7::varchar = 'skipped' then clock_timestamp() else null end
       )`,
      [
        nodeRunId,
        workspaceId,
        runId,
        admission.nodeId,
        admission.invocationKey,
        serializeStoredExecutionJsonValue({
          ...('branchPath' in invocation && invocation.branchPath !== undefined
            ? { branchPath: invocation.branchPath }
            : {}),
          ...('iterationPath' in invocation &&
          invocation.iterationPath !== undefined
            ? { iterationPath: invocation.iterationPath }
            : {}),
        }),
        invocation.status === 'pending'
          ? 'pending'
          : invocation.status === 'skipped'
            ? 'skipped'
            : 'ready',
        admission.sideEffectClass,
        admission.providerIdempotencyKey ?? null,
        attemptId ?? null,
        attempt?.attemptNumber ?? null,
      ],
    );
    physical.set(admission.invocationKey, {
      nodeRunId,
      ...(attemptId === undefined || attempt === undefined
        ? {}
        : { attemptId, attemptNumber: attempt.attemptNumber }),
    });
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
    await client.query(
      `insert into app.node_attempts (
         id, workspace_id, node_run_id, attempt_number, status,
         side_effect_class, provider_idempotency_key, admission_kind
       ) values ($1,$2,$3,$4,'ready',$5,$6,$7)`,
      [
        ids.attemptId,
        workspaceId,
        ids.nodeRunId,
        attempt.attemptNumber,
        attempt.sideEffectClass,
        attempt.providerIdempotencyKey ?? null,
        attempt.admissionKind,
      ],
    );
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
    await client.query(
      `insert into app.outbox_events (
         id, workspace_id, job_name, schema_version, aggregate_type,
         aggregate_id, payload, payload_checksum
       ) values ($1,$2,'execute-node-attempt',1,'node-attempt',$3,$4::jsonb,$5)`,
      [
        outboxEventId,
        workspaceId,
        ids.attemptId,
        serializeStoredExecutionJsonValue(payload),
        canonicalOutboxPayloadChecksum(payload),
      ],
    );
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
  for (const event of plan.events) {
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
    await client.query(
      `insert into app.run_events (
         workspace_id, workflow_run_id, sequence, type, payload, created_at
       ) values ($1,$2,$3,$4,$5::jsonb,$6)`,
      [
        workspaceId,
        runId,
        event.sequence,
        event.name,
        serializeStoredExecutionJsonValue(payload),
        event.occurredAt,
      ],
    );
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
