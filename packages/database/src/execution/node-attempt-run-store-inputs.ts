import { createHash } from 'node:crypto';

import type { Pool } from 'pg';
import { z } from 'zod';

import { parsePersistedWorkflowCheckpoint } from '../compatibility/persisted-workflow-checkpoint.js';
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
import {
  parseStoredExecutionValueV1,
  serializeStoredExecutionJsonValue,
} from './stored-execution-value.js';

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

      const completedNodeOutputs: {
        invocationKey: string;
        nodeId: string;
        value: unknown;
      }[] = [];
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
        if (outputs.rows.length !== input.upstreamNodeOutputs.length)
          throw new NodeAttemptStateCorruptError();
        const outputsByInvocationKey = new Map(
          outputs.rows.map((output) => [output.invocation_key, output]),
        );
        for (const expected of input.upstreamNodeOutputs) {
          const output = outputsByInvocationKey.get(expected.invocationKey);
          if (
            output?.node_id !== expected.nodeId ||
            serializeStoredExecutionJsonValue(output.node_output_ref) !==
              serializeStoredExecutionJsonValue(output.attempt_output_ref)
          )
            throw new NodeAttemptStateCorruptError();
          const stored = parseStoredExecutionValueV1(output.attempt_output_ref);
          if (stored.kind !== 'inline')
            throw new NodeAttemptStateCorruptError();
          completedNodeOutputs.push({
            invocationKey: output.invocation_key,
            nodeId: output.node_id,
            value: stored.value,
          });
        }
      }
      const checkpoint = parsePersistedWorkflowCheckpoint(row.scheduler_state);
      const join = checkpoint.joins.find(
        ({ joinInvocationKey }) =>
          joinInvocationKey === input.lease.invocationKey,
      );
      const coordinatorInput =
        join?.selectedBranchIds === undefined
          ? undefined
          : {
              ledger: Object.fromEntries(
                join.ledger.map(({ branchId, disposition, output }) => [
                  branchId,
                  {
                    disposition,
                    ...(output === undefined ? {} : { output }),
                  },
                ]),
              ),
              selectedBranchIds: join.selectedBranchIds,
            };
      let structuredCollection:
        NonNullable<NodeAttemptInputs['structuredCollection']> | undefined;
      const iterationPath = input.lease.iterationPath ?? [];
      if (iterationPath.length > 0) {
        const branchPath = input.lease.branchPath ?? [];
        const declaredLoops = iterationPath.map((scope, index) => {
          const enclosingIterationPath = iterationPath.slice(0, index);
          const matches = checkpoint.loops.filter(
            (loop) =>
              loop.loopId === scope.loopNodeId &&
              serializeStoredExecutionJsonValue(loop.iterationPath) ===
                serializeStoredExecutionJsonValue(enclosingIterationPath) &&
              loop.branchPath.length <= branchPath.length &&
              loop.branchPath.every((part, branchIndex) => {
                const leasePart = branchPath[branchIndex];
                return (
                  leasePart?.nodeId === part.nodeId &&
                  leasePart.outputPort === part.outputPort
                );
              }) &&
              loop.activeOrdinals.includes(scope.ordinal),
          );
          if (matches.length !== 1) throw new NodeAttemptStateCorruptError();
          return matches[0];
        });
        const nearestScope = iterationPath.at(-1);
        const nearestLoop = declaredLoops.at(-1);
        if (nearestScope === undefined || nearestLoop === undefined)
          throw new NodeAttemptStateCorruptError();
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
            nearestLoop.controlInvocationKey,
          ],
        );
        const declarationRow = declaration.rows[0];
        if (
          declaration.rows.length !== 1 ||
          declarationRow?.node_id !== nearestLoop.loopId ||
          nearestLoop.collection.kind !== 'inline' ||
          nearestLoop.collection.attemptId !== declarationRow.attempt_id ||
          serializeStoredExecutionJsonValue(declarationRow.node_output_ref) !==
            serializeStoredExecutionJsonValue(declarationRow.attempt_output_ref)
        )
          throw new NodeAttemptStateCorruptError();
        const stored = parseStoredExecutionValueV1(
          declarationRow.attempt_output_ref,
        );
        if (
          stored.kind !== 'inline' ||
          stored.value === null ||
          Array.isArray(stored.value) ||
          typeof stored.value !== 'object'
        )
          throw new NodeAttemptStateCorruptError();
        const declarationOutput = stored.value as Readonly<
          Record<string, unknown>
        >;
        const keys = Object.keys(declarationOutput).sort();
        const items = declarationOutput.items;
        const iterationCount = declarationOutput.iterationCount;
        const collectionChecksum = Array.isArray(items)
          ? createHash('sha256')
              .update(serializeStoredExecutionJsonValue(items))
              .digest('hex')
          : undefined;
        if (
          keys.length !== 2 ||
          keys[0] !== 'items' ||
          keys[1] !== 'iterationCount' ||
          !Array.isArray(items) ||
          typeof iterationCount !== 'number' ||
          !Number.isSafeInteger(iterationCount) ||
          iterationCount !== items.length ||
          nearestLoop.collectionSize !== items.length ||
          nearestScope.ordinal < 0 ||
          nearestScope.ordinal >= items.length ||
          nearestLoop.collectionChecksum !== collectionChecksum
        )
          throw new NodeAttemptStateCorruptError();
        structuredCollection = Object.freeze({
          loopNodeId: nearestLoop.loopId,
          ordinal: nearestScope.ordinal,
          collection: items,
          collectionSize: nearestLoop.collectionSize,
          declaredCollectionChecksum: nearestLoop.collectionChecksum,
        });
      }
      return Object.freeze({
        runInput,
        completedNodeOutputs: Object.freeze(completedNodeOutputs),
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
