import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type { parsePersistedWorkflowCheckpoint } from '../../compatibility/persisted-workflow-checkpoint.js';
import type { parsePersistedWorkflowCheckpointV3 } from '../../compatibility/persisted-workflow-checkpoint-v3.js';
import {
  NodeAttemptStateCorruptError,
  type loadInputsSchema,
  type NodeAttemptInputs,
} from './node-attempt-run-store-contract.js';
import {
  parseStoredExecutionValueV1,
  serializeStoredExecutionJsonValue,
} from '../stored-execution-value.js';
import { readWorkflowCallResultReference } from '../workflow-calls/workflow-call-result-reference.js';

type ParsedCheckpoint =
  | ReturnType<typeof parsePersistedWorkflowCheckpoint>
  | ReturnType<typeof parsePersistedWorkflowCheckpointV3>;
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

/** Reconcile selected retained upstream values, including authenticated logical Call results. */
export async function loadNodeAttemptCompletedInputs(
  client: PoolClient,
  input: z.output<typeof loadInputsSchema>,
  checkpoint: ParsedCheckpoint,
): Promise<NodeAttemptInputs['completedNodeOutputs']> {
  let completedNodeOutputs: NodeAttemptInputs['completedNodeOutputs'] =
    Object.freeze([]);
  if (input.upstreamNodeOutputs.length > 0) {
    const outputs = await client.query<{
      invocation_key: string;
      node_id: string;
      node_output_ref: unknown;
      attempt_output_ref: unknown;
      node_input_ref: unknown;
      attempt_id: string;
    }>(
      `select node.invocation_key,node.node_id,
              node.output_ref as node_output_ref,node.input_ref as node_input_ref,attempt.id as attempt_id,
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
    const projectedRows = [];
    for (const output of outputs.rows) {
      const invocation = checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === output.invocation_key,
      );
      if (invocation?.output?.kind !== 'workflow_call') {
        projectedRows.push(output);
        continue;
      }
      if (checkpoint.schemaVersion !== 3)
        throw new NodeAttemptStateCorruptError();
      const call = checkpoint.calls.find(
        ({ invocationKey }) => invocationKey === output.invocation_key,
      );
      if (
        call?.status !== 'settled' ||
        call.childStatus !== 'succeeded' ||
        call.declarationAttemptId !== output.attempt_id ||
        serializeStoredExecutionJsonValue(output.node_input_ref) !==
          serializeStoredExecutionJsonValue(output.attempt_output_ref)
      )
        throw new NodeAttemptStateCorruptError();
      const referenceJson = await readWorkflowCallResultReference(client, {
        workspaceId: input.lease.workspaceId,
        parentRunId: input.lease.runId,
        invocationKey: output.invocation_key,
        childRunId: invocation.output.childRunId,
      });
      const reference: unknown = JSON.parse(referenceJson);
      if (
        serializeStoredExecutionJsonValue(reference) !==
        serializeStoredExecutionJsonValue(output.node_output_ref)
      )
        throw new NodeAttemptStateCorruptError();
      // Reconcile the authenticated logical result, never the declaration input.
      projectedRows.push({ ...output, attempt_output_ref: reference });
    }
    completedNodeOutputs = reconcileCompletedNodeOutputs(
      input.upstreamNodeOutputs,
      projectedRows,
    );
  }
  return completedNodeOutputs;
}
