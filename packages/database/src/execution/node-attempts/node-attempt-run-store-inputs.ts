import type { Pool } from 'pg';
import { z } from 'zod';

import {
  loadInputsSchema,
  NodeAttemptStateCorruptError,
  type NodeAttemptLoopDeclaration,
  type NodeAttemptRunStore,
  type NodeAttemptStoredInputs,
} from './node-attempt-run-store-contract.js';
import {
  assertNotAborted,
  withWorkspaceReadClient,
} from './node-attempt-run-store-transactions.js';
import {
  parseStoredExecutionValueV1,
  serializeStoredExecutionJsonValue,
} from '../stored-execution-value.js';

type UpstreamOutputRow = Readonly<{
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
      if (
        output?.node_id !== expected.nodeId ||
        serializeStoredExecutionJsonValue(output.node_output_ref) !==
          serializeStoredExecutionJsonValue(output.attempt_output_ref)
      )
        throw new NodeAttemptStateCorruptError();
      const stored = parseStoredExecutionValueV1(output.attempt_output_ref);
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
        scheduler_state: unknown;
      }>(
        `select run.input_ref,run.deadline_at,checkpoint.scheduler_state,
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
        const stored = parseStoredExecutionValueV1(row.input_ref);
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
        const stored = parseStoredExecutionValueV1(resumed.rows[0]?.output_ref);
        if (stored.kind !== 'inline') throw new NodeAttemptStateCorruptError();
        resumeOutput = stored.value;
      }

      let completedNodeOutputs: NodeAttemptStoredInputs['completedNodeOutputs'] =
        Object.freeze([]);
      if (input.upstreamNodeOutputs.length > 0) {
        const outputs = await client.query<{
          invocation_key: string;
          node_id: string;
          node_output_ref: unknown;
          attempt_output_ref: unknown;
        }>(
          `select node.invocation_key,node.node_id,
                  node.output_ref as node_output_ref,
                  attempt.output_ref as attempt_output_ref
           from app.node_runs node
           join app.node_attempts attempt
             on attempt.workspace_id=node.workspace_id
            and attempt.id=node.current_attempt_id
            where node.workspace_id=$1 and node.workflow_run_id=$2
              and node.invocation_key=any($3::varchar[])
              and node.status='succeeded' and attempt.status='succeeded'
              and attempt.node_run_id=node.id`,
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
      return Object.freeze({
        runInput,
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

export async function readNodeAttemptLoopDeclaration(
  pool: Pool,
  input: Parameters<NodeAttemptRunStore['readLoopDeclaration']>[0],
): Promise<NodeAttemptLoopDeclaration | undefined> {
  assertNotAborted(input.signal);
  return withWorkspaceReadClient(
    pool,
    input.lease.workspaceId,
    input.signal,
    async (client) => {
      const declaration = await client.query<{
        attempt_id: string;
        attempt_output_ref: unknown;
        node_output_ref: unknown;
        node_id: string;
      }>(
        `select node.node_id,node.current_attempt_id as attempt_id,
                node.output_ref as node_output_ref,
                attempt.output_ref as attempt_output_ref
         from app.node_runs node
         join app.node_attempts attempt
           on attempt.workspace_id=node.workspace_id
          and attempt.id=node.current_attempt_id
          and attempt.node_run_id=node.id
         where node.workspace_id=$1 and node.workflow_run_id=$2
           and node.invocation_key=$3
           and attempt.status='succeeded'`,
        [
          input.lease.workspaceId,
          input.lease.runId,
          input.controlInvocationKey,
        ],
      );
      if (declaration.rows.length > 1) throw new NodeAttemptStateCorruptError();
      const row = declaration.rows[0];
      if (row === undefined) return undefined;
      if (
        serializeStoredExecutionJsonValue(row.node_output_ref) !==
        serializeStoredExecutionJsonValue(row.attempt_output_ref)
      )
        throw new NodeAttemptStateCorruptError();
      const stored = parseStoredExecutionValueV1(row.attempt_output_ref);
      if (stored.kind !== 'inline') throw new NodeAttemptStateCorruptError();
      return Object.freeze({
        nodeId: row.node_id,
        attemptId: row.attempt_id,
        output: stored.value,
      });
    },
  );
}
