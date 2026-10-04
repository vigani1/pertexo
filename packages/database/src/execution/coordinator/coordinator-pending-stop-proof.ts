import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { encodeWorkflowInvocationKeyV2 } from '@pertexo/workflow-model/invocation-key-v2';
import { workflowControlOutputNodeIdsV3 } from '@pertexo/workflow-model/graph';
import type { CoordinatorCheckpoint } from './coordinator-checkpoint.js';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';
import { CoordinatorPlanInvalidError } from './coordinator-run-store-contract.js';
import { record } from './coordinator-run-store-observations.js';

function require(value: boolean): asserts value {
  if (!value) throw new CoordinatorPlanInvalidError();
}
function pinnedNodeIds(executable: unknown) {
  workflowControlOutputNodeIdsV3(executable);
  const pending = [record(record(executable).graph)];
  const ids = new Set<string>();
  while (pending.length) {
    const graph = pending.pop();
    require(graph !== undefined && Array.isArray(graph.nodes));
    for (const raw of graph.nodes as unknown[]) {
      const node = record(raw);
      require(typeof node.id === 'string' && !ids.has(node.id));
      ids.add(node.id);
      if (node.structured !== undefined)
        pending.push(record(record(node.structured).body));
    }
  }
  return ids;
}

/** Internal locked proof, not caller authority: never-started native pending nodes only. */
export async function lockNativePendingStops(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    executable: unknown;
    current: CoordinatorCheckpoint;
    plan: ParsedTransitionPlan;
    canceled: boolean;
    deadlineExpired: boolean;
  }>,
): Promise<ReadonlySet<string>> {
  const { current, plan } = input;
  if (current.schemaVersion !== 3 || plan.checkpoint.schemaVersion !== 3)
    return new Set();
  const previous = new Map(
    current.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  const changed = plan.checkpoint.invocations.filter(
    (invocation) =>
      previous.get(invocation.invocationKey)?.status === 'pending' &&
      invocation.status !== 'pending',
  );
  if (!changed.length) return new Set();
  require(input.canceled || input.deadlineExpired);
  require(
    plan.checkpoint.cancelRequested === input.canceled &&
      plan.checkpoint.deadlineExpired === input.deadlineExpired,
  );
  require(plan.attempts.length === 0 && plan.nodeRunAdmissions.length === 0);
  require(
    plan.checkpoint.remainingIterationBudget ===
      current.remainingIterationBudget,
  );
  const pins = pinnedNodeIds(input.executable);
  for (const next of changed) {
    const before = previous.get(next.invocationKey);
    require(
      before?.attemptNumber === 0 &&
        before.output === undefined &&
        before.resumeAt === undefined &&
        before.waitKind === undefined,
    );
    require(
      next.status === 'canceled' &&
        isDeepStrictEqual({ ...before, status: 'canceled' }, next),
    );
    require(pins.has(next.nodeId));
    require(
      encodeWorkflowInvocationKeyV2({
        workflowVersionId: current.workflowVersionId,
        nodeId: before.nodeId,
        branchPath: ('branchPath' in before
          ? (before.branchPath ?? [])
          : []
        ).map(({ nodeId, outputPort }) => `${nodeId}:${outputPort}`),
        iterationPath:
          'iterationPath' in before ? (before.iterationPath ?? []) : [],
      }) === next.invocationKey,
    );
    const events = plan.events.filter(
      ({ invocationKey }) => invocationKey === next.invocationKey,
    );
    require(
      events.length === 1 &&
        events[0]?.name === 'node.canceled' &&
        events[0].nodeId === next.nodeId &&
        events[0].attemptNumber === 0 &&
        events[0].reasonCode === undefined,
    );
  }
  const result = await client.query<{
    invocation_key: string;
    node_id: string;
    status: string;
    branch_context: unknown;
    current_attempt_id: string | null;
    current_attempt_number: number | null;
    output_ref: unknown;
    attempt_count: number;
  }>(
    `select node.invocation_key,node.node_id,node.status,node.branch_context,
            node.current_attempt_id,node.current_attempt_number,node.output_ref,
            (select count(*)::int from app.node_attempts attempt
             where attempt.workspace_id=node.workspace_id and attempt.node_run_id=node.id) as attempt_count
       from app.node_runs node
       where node.workspace_id=$1 and node.workflow_run_id=$2 and node.invocation_key=any($3::varchar[])
       order by node.invocation_key for update of node`,
    [
      input.workspaceId,
      input.runId,
      changed.map(({ invocationKey }) => invocationKey),
    ],
  );
  require(result.rows.length === changed.length);
  const physical = new Map(result.rows.map((row) => [row.invocation_key, row]));
  require(physical.size === changed.length);
  for (const next of changed) {
    const row = physical.get(next.invocationKey);
    require(row?.node_id === next.nodeId && row.status === 'pending');
    require(
      row.current_attempt_id === null &&
        row.current_attempt_number === null &&
        row.attempt_count === 0 &&
        row.output_ref === null,
    );
    const scope = {
      ...('branchPath' in next && next.branchPath !== undefined
        ? { branchPath: next.branchPath }
        : {}),
      ...('iterationPath' in next && next.iterationPath !== undefined
        ? { iterationPath: next.iterationPath }
        : {}),
    };
    require(isDeepStrictEqual(record(row.branch_context), scope));
  }
  return new Set(changed.map(({ invocationKey }) => invocationKey));
}
