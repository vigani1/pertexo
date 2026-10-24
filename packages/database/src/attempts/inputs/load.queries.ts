import { drizzle } from 'drizzle-orm/node-postgres';
import { readVariableSetValues } from '../../variables/values.queries.js';
import { workflowNodeFailureValueSchema } from '@pertexo/workflow-model';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  loadInputsSchema,
  NodeAttemptStateCorruptError,
  type NodeAttemptRunStore,
  type NodeAttemptStoredInputs,
} from '../contract.js';
import {
  assertNotAborted,
  withWorkspaceReadClient,
} from '../transactions.repository.js';
import {
  parseStoredExecutionValue,
  storedExecutionValuesEqual,
} from '../../platform/stored-execution-value.js';

export {
  readNodeAttemptLoopDeclaration,
  readNodeAttemptOutputs,
  listNodeRunOutcomes,
  readNodeRunOutputs,
} from '../queries/outputs.queries.js';
type UpstreamOutputRow = Readonly<{
  node_run_id: string;
  current_attempt_id: string | null;
  current_attempt_number: number | null;
  reused_source_run_id: string | null;
  reused_source_node_run_id: string | null;
  reused_source_completed_at: Date | null;
  attempt_status: string | null;
  invocation_key: string;
  node_id: string;
  node_output_ref: unknown;
  attempt_output_ref: unknown;
}>;

function reconcileCompletedNodeOutputs(
  expectedOutputs: z.output<typeof loadInputsSchema>['upstreamNodeOutputs'],
  rows: readonly UpstreamOutputRow[],
): readonly Readonly<{
  invocationKey: string;
  nodeId: string;
  value: unknown;
}>[] {
  if (rows.length !== expectedOutputs.length)
    throw new NodeAttemptStateCorruptError();
  const outputsByInvocationKey = new Map(
    rows.map((output) => [output.invocation_key, output]),
  );
  return Object.freeze(
    expectedOutputs.map((expected) => {
      const output = outputsByInvocationKey.get(expected.invocationKey);
      if (output?.node_id !== expected.nodeId)
        throw new NodeAttemptStateCorruptError();
      const reused = output.reused_source_run_id !== null;
      if (reused) {
        const invalidReusedOutput =
          output.reused_source_node_run_id === null ||
          output.reused_source_completed_at === null ||
          output.current_attempt_id !== null ||
          output.current_attempt_number !== null ||
          output.attempt_status !== null;
        if (invalidReusedOutput) throw new NodeAttemptStateCorruptError();
      } else {
        const invalidAttemptOutput =
          output.attempt_status !== 'succeeded' ||
          output.reused_source_node_run_id !== null ||
          output.reused_source_completed_at !== null ||
          !storedExecutionValuesEqual(
            output.node_output_ref,
            output.attempt_output_ref,
          );
        if (invalidAttemptOutput) throw new NodeAttemptStateCorruptError();
      }
      const stored = parseStoredExecutionValue(
        reused ? output.node_output_ref : output.attempt_output_ref,
      );
      if (stored.kind !== 'inline') throw new NodeAttemptStateCorruptError();
      return Object.freeze({
        invocationKey: output.invocation_key,
        nodeId: output.node_id,
        value: stored.value,
      });
    }),
  );
}

export async function loadNodeAttemptInputs(
  pool: Pool,
  inputValue: Parameters<NodeAttemptRunStore['loadInputs']>[0],
): Promise<NodeAttemptStoredInputs> {
  assertNotAborted(inputValue.signal);
  let input: z.output<typeof loadInputsSchema>;
  try {
    input = loadInputsSchema.parse(inputValue);
  } catch {
    throw new NodeAttemptStateCorruptError();
  }
  return withWorkspaceReadClient(
    pool,
    input.lease.workspaceId,
    input.signal,
    async (client) => {
      const current = await client.query<{
        abort_reason: 'canceled' | 'timed_out' | null;
        abort_requested: boolean;
        deadline_at: Date | null;
        input_ref: unknown;
        variable_set_revision: number | null;
        scheduler_state: unknown;
      }>(
        `select run.input_ref,run.variable_set_revision,run.deadline_at,checkpoint.scheduler_state,
                (run.cancel_requested_at is not null or
                 (run.deadline_at is not null and
                  run.deadline_at <= clock_timestamp())) as abort_requested,
                case
                  when run.cancel_requested_at is not null then 'canceled'
                  when run.deadline_at is not null and
                       run.deadline_at <= clock_timestamp() then 'timed_out'
                  else null
                end as abort_reason
         from app.workflow_runs run
         join app.node_runs node
           on node.workspace_id=run.workspace_id
          and node.workflow_run_id=run.id
         join app.node_attempts attempt
           on attempt.workspace_id=node.workspace_id
           and attempt.node_run_id=node.id
         join app.run_checkpoints checkpoint
           on checkpoint.workspace_id=run.workspace_id
          and checkpoint.workflow_run_id=run.id
         where run.workspace_id=$1 and run.id=$2
           and run.workflow_version_id=$3 and node.id=$4
           and node.node_id=$5 and node.invocation_key=$6
           and node.current_attempt_id=$7
           and node.current_attempt_number=$8
           and attempt.id=$7 and attempt.attempt_number=$8
           and attempt.status='running' and attempt.lease_owner=$9
           and attempt.fence_token=$10
           and attempt.lease_expires_at > clock_timestamp()`,
        [
          input.lease.workspaceId,
          input.lease.runId,
          input.lease.workflowVersionId,
          input.lease.nodeRunId,
          input.lease.nodeId,
          input.lease.invocationKey,
          input.lease.attemptId,
          input.lease.attemptNumber,
          input.lease.workerId,
          input.lease.fenceToken,
        ],
      );
      const row = current.rows[0];
      if (row === undefined) throw new NodeAttemptStateCorruptError();
      let runInput: unknown = null;
      if (row.input_ref !== null) {
        const stored = parseStoredExecutionValue(row.input_ref);
        if (stored.kind !== 'inline') throw new NodeAttemptStateCorruptError();
        runInput = stored.value;
      }
      let resumeOutput: unknown;
      if (input.lease.admissionKind === 'wait_resume') {
        const resumed = await client.query<{ output_ref: unknown }>(
          `select output_ref from app.node_runs
           where workspace_id=$1 and id=$2 and current_attempt_id=$3`,
          [
            input.lease.workspaceId,
            input.lease.nodeRunId,
            input.lease.attemptId,
          ],
        );
        const stored = parseStoredExecutionValue(resumed.rows[0]?.output_ref);
        if (stored.kind !== 'inline') throw new NodeAttemptStateCorruptError();
        resumeOutput = stored.value;
      }

      let completedNodeOutputs: NodeAttemptStoredInputs['completedNodeOutputs'] =
        Object.freeze([]);
      if (input.upstreamNodeOutputs.length > 0) {
        const outputs = await client.query<UpstreamOutputRow>(
          `select node.id as node_run_id,node.invocation_key,node.node_id,
                  node.current_attempt_id,node.current_attempt_number,
                  node.reused_source_run_id,node.reused_source_node_run_id,node.reused_source_completed_at,
                  attempt.status as attempt_status,
                  node.output_ref as node_output_ref,
                  case when task.id is not null then task.output_ref when call.id is not null then call.result_ref else attempt.output_ref end as attempt_output_ref
           from app.node_runs node
           left join app.node_attempts attempt
             on attempt.workspace_id=node.workspace_id
            and attempt.id=node.current_attempt_id
            and attempt.node_run_id=node.id
           left join app.workflow_calls call
             on call.workspace_id=node.workspace_id and call.parent_run_id=node.workflow_run_id
            and call.invocation_key=node.invocation_key and call.status='succeeded'
           left join app.pending_run_tasks task on task.workspace_id=node.workspace_id and task.node_run_id=node.id and task.run_id=node.workflow_run_id and task.status in ('approved','rejected','submitted')
            where node.workspace_id=$1 and node.workflow_run_id=$2
              and node.invocation_key=any($3::varchar[])
              and node.status='succeeded'`,
          [
            input.lease.workspaceId,
            input.lease.runId,
            input.upstreamNodeOutputs.map(({ invocationKey }) => invocationKey),
          ],
        );
        completedNodeOutputs = reconcileCompletedNodeOutputs(
          input.upstreamNodeOutputs,
          outputs.rows,
        );
      }
      const sourceFailure = await readSourceFailure(client, input);
      return Object.freeze({
        ...(sourceFailure === undefined ? {} : { sourceFailure }),
        runInput,
        variables: await readVariableSetValues(
          drizzle(client),
          input.lease.workspaceId,
          row.variable_set_revision,
        ),
        completedNodeOutputs,
        abortRequested: row.abort_requested,
        ...(row.abort_reason === null ? {} : { abortReason: row.abort_reason }),
        ...(row.deadline_at === null
          ? {}
          : { deadlineAt: z.coerce.date().parse(row.deadline_at) }),
        ...(resumeOutput === undefined ? {} : { resumeOutput }),
        checkpoint: row.scheduler_state,
      });
    },
  );
}

async function readSourceFailure(
  client: PoolClient,
  input: z.output<typeof loadInputsSchema>,
): Promise<NodeAttemptStoredInputs['sourceFailure']> {
  let sourceFailure: NodeAttemptStoredInputs['sourceFailure'];
  if (input.sourceFailure !== undefined) {
    const source = await client.query<{
      failure_ref: unknown;
      current_attempt_number: number;
    }>(
      `select source.failure_ref,source.current_attempt_number from app.node_runs source
           join app.node_runs handler on handler.workspace_id=source.workspace_id and handler.workflow_run_id=source.workflow_run_id
             and handler.invocation_key=source.failure_handler_entry_key
           join app.node_attempts attempt on attempt.workspace_id=handler.workspace_id and attempt.node_run_id=handler.id
           where source.workspace_id=$1 and source.workflow_run_id=$2 and source.node_id=$3 and source.invocation_key=$4
             and source.status='failed' and source.failure_handling='pending'
             and handler.id=$5 and handler.current_attempt_id=$6 and handler.current_attempt_number=$7
             and attempt.id=$6 and attempt.attempt_number=$7 and attempt.status='running'
             and attempt.lease_owner=$8 and attempt.fence_token=$9 and attempt.lease_expires_at > clock_timestamp()`,
      [
        input.lease.workspaceId,
        input.lease.runId,
        input.sourceFailure.nodeId,
        input.sourceFailure.invocationKey,
        input.lease.nodeRunId,
        input.lease.attemptId,
        input.lease.attemptNumber,
        input.lease.workerId,
        input.lease.fenceToken,
      ],
    );
    const selectedSource = source.rows[0];
    if (source.rows.length !== 1 || selectedSource === undefined)
      throw new NodeAttemptStateCorruptError();
    const stored = parseStoredExecutionValue(selectedSource.failure_ref);
    const parsed =
      stored.kind === 'inline'
        ? workflowNodeFailureValueSchema.safeParse(stored.value)
        : undefined;
    const invalidSourceFailure =
      !parsed?.success ||
      parsed.data.attemptNumber !== selectedSource.current_attempt_number ||
      parsed.data.nodeId !== input.sourceFailure.nodeId ||
      parsed.data.invocationKey !== input.sourceFailure.invocationKey;
    if (invalidSourceFailure) throw new NodeAttemptStateCorruptError();
    sourceFailure = parsed.data;
  }

  return sourceFailure;
}
