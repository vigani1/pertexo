import type { PoolClient } from 'pg';
import { CoordinatorRunStateCorruptError } from './coordinator-run-store-contract.js';
import type { PendingCoordinatorFailure } from './coordinator-run-store-commit-state.js';
import { terminalStatus } from './coordinator-run-store-observations.js';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';
import { serializeStoredExecutionJsonValue } from '../stored-execution-value.js';
import type { RejectedForEachDeclarations } from './coordinator-rejected-loop-proof.js';

export type CoordinatorExecutionIdentity = Readonly<{
  nodeRunId: string;
  attemptId?: string;
  attemptNumber?: number;
}>;

export type ExecutionIdentityMap = Map<string, CoordinatorExecutionIdentity>;

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

export async function persistCoordinatorExecutionEvents(
  client: PoolClient,
  input: Readonly<{
    pendingFailures: readonly PendingCoordinatorFailure[];
    physical: ExecutionIdentityMap;
    plan: ParsedTransitionPlan;
    runId: string;
    workspaceId: string;
    rejectedForEachDeclarations: RejectedForEachDeclarations;
  }>,
): Promise<void> {
  const { pendingFailures, physical, plan, runId, workspaceId } = input;
  await loadEventExecutionIdentities(
    client,
    physical,
    plan,
    workspaceId,
    runId,
  );
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
      !pendingFailureInvocations.has(event.invocationKey) &&
      !input.rejectedForEachDeclarations.has(event.invocationKey) &&
      !(
        plan.checkpoint.schemaVersion === 3 &&
        plan.checkpoint.calls.some(
          ({ invocationKey }) => invocationKey === event.invocationKey,
        )
      )
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
