import { loadNativeNodeAttemptInputs } from './node-attempt-native-inputs.js';
import { loadNodeAttemptStructuredCollection } from './node-attempt-structured-inputs.js';
import type { Pool } from 'pg';
import { z } from 'zod';

import { parsePersistedWorkflowCheckpoint } from '../../compatibility/persisted-workflow-checkpoint.js';
import { parsePersistedWorkflowCheckpointV3 } from '../../compatibility/persisted-workflow-checkpoint-v3.js';
import {
  loadInputsSchema,
  NodeAttemptStateCorruptError,
  type NodeAttemptInputs,
  type NodeAttemptRunStore,
} from './node-attempt-run-store-contract.js';
import {
  assertNotAborted,
  scopedInvocationKey,
  withWorkspaceReadClient,
} from './node-attempt-run-store-transactions.js';
import { parseStoredExecutionValueV1 } from '../stored-execution-value.js';
import { loadNodeAttemptCompletedInputs } from './node-attempt-completed-inputs.js';

type ParsedCheckpoint =
  | ReturnType<typeof parsePersistedWorkflowCheckpoint>
  | ReturnType<typeof parsePersistedWorkflowCheckpointV3>;
function assertPermittedUpstreamInvocationScopes(
  input: z.output<typeof loadInputsSchema>,
): void {
  if (
    input.upstreamNodeOutputs.some(({ nodeId, invocationKey }) => {
      const branchPath = input.lease.branchPath ?? [];
      const nearestBranch = branchPath.at(-1);
      const possibleBranchPaths = [branchPath];
      if (nearestBranch?.nodeId === nodeId)
        possibleBranchPaths.push(branchPath.slice(0, -1));
      return !possibleBranchPaths.some(
        (candidateBranchPath) =>
          invocationKey ===
          scopedInvocationKey({
            workflowVersionId: input.lease.workflowVersionId,
            nodeId,
            branchPath: candidateBranchPath,
            ...(input.lease.iterationPath === undefined
              ? {}
              : { iterationPath: input.lease.iterationPath }),
          }),
      );
    })
  )
    throw new NodeAttemptStateCorruptError();
}

function projectCoordinatorInput(
  checkpoint: ParsedCheckpoint,
  invocationKey: string,
) {
  const join = checkpoint.joins.find(
    ({ joinInvocationKey }) => joinInvocationKey === invocationKey,
  );
  return join?.selectedBranchIds === undefined
    ? undefined
    : Object.freeze({
        ledger: Object.fromEntries(
          join.ledger.map(({ branchId, disposition, output }) => [
            branchId,
            { disposition, ...(output === undefined ? {} : { output }) },
          ]),
        ),
        selectedBranchIds: join.selectedBranchIds,
      });
}

export async function loadNodeAttemptInputs(
  pool: Pool,
  inputValue: Parameters<NodeAttemptRunStore['loadInputs']>[0],
): Promise<NodeAttemptInputs> {
  assertNotAborted(inputValue.signal);
  let input: z.output<typeof loadInputsSchema>;
  try {
    input = loadInputsSchema.parse(inputValue);
  } catch {
    throw new NodeAttemptStateCorruptError();
  }
  assertPermittedUpstreamInvocationScopes(input);
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
        graph_schema_version: number;
        executable_schema_version: number | null;
        executable_checksum: string;
      }>(
        `select run.input_ref,run.deadline_at,checkpoint.scheduler_state,
                version.schema_version as graph_schema_version,
                version.executable_schema_version,version.checksum as executable_checksum,
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
         join app.workflow_versions version
           on version.workspace_id=run.workspace_id
          and version.workflow_id=run.workflow_id
          and version.id=run.workflow_version_id
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
      // The real retained version, never a checkpoint's self-reported grammar,
      // selects the parser. Partial native pairs cannot fall back to V1/V2.
      const native =
        row.graph_schema_version === 2 &&
        row.executable_schema_version === 3 &&
        /^wf:v3:sha256:[0-9a-f]{64}$/u.test(row.executable_checksum);
      const retained =
        row.graph_schema_version === 1 &&
        ((row.executable_schema_version === 2 &&
          /^wf:v2:sha256:[0-9a-f]{64}$/u.test(row.executable_checksum)) ||
          (row.executable_schema_version === null &&
            /^wf:v1:sha256:[0-9a-f]{64}$/u.test(row.executable_checksum)));
      if (!native && !retained) throw new NodeAttemptStateCorruptError();
      const checkpoint = native
        ? parsePersistedWorkflowCheckpointV3(row.scheduler_state)
        : parsePersistedWorkflowCheckpoint(row.scheduler_state);
      if (checkpoint.workflowVersionId !== input.lease.workflowVersionId)
        throw new NodeAttemptStateCorruptError();
      if (native) {
        return loadNativeNodeAttemptInputs(
          client,
          input,
          row,
          projectCoordinatorInput(checkpoint, input.lease.invocationKey),
        );
      }
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

      const completedNodeOutputs = await loadNodeAttemptCompletedInputs(
        client,
        input,
        checkpoint,
      );
      const coordinatorInput = projectCoordinatorInput(
        checkpoint,
        input.lease.invocationKey,
      );
      const structuredCollection = await loadNodeAttemptStructuredCollection(
        client,
        input,
        checkpoint,
      );
      return Object.freeze({
        runInput,
        completedNodeOutputs,
        ...(coordinatorInput === undefined ? {} : { coordinatorInput }),
        ...(structuredCollection === undefined ? {} : { structuredCollection }),
        abortRequested: row.abort_requested,
        ...(row.abort_reason === null ? {} : { abortReason: row.abort_reason }),
        ...(row.deadline_at === null
          ? {}
          : { deadlineAt: z.coerce.date().parse(row.deadline_at) }),
        ...(resumeOutput === undefined ? {} : { resumeOutput }),
      });
    },
  );
}
