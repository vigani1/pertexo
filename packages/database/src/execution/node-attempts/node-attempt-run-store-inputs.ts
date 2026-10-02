import { createHash } from 'node:crypto';

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
import {
  parseStoredExecutionValueV1,
  serializeStoredExecutionJsonValue,
} from '../stored-execution-value.js';
import { readWorkflowCallResultReference } from '../workflow-calls/workflow-call-result-reference.js';

type ParsedCheckpoint =
  | ReturnType<typeof parsePersistedWorkflowCheckpoint>
  | ReturnType<typeof parsePersistedWorkflowCheckpointV3>;
type StructuredLoopDeclaration = Extract<
  ParsedCheckpoint,
  { schemaVersion: 2 }
>['loops'][number];
type UpstreamOutputRow = Readonly<{
  invocation_key: string;
  node_id: string;
  node_output_ref: unknown;
  attempt_output_ref: unknown;
}>;
type LoopDeclarationRow = Readonly<{
  attempt_id: string;
  attempt_output_ref: unknown;
  node_output_ref: unknown;
  node_id: string;
}>;

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

function selectStructuredLoopDeclarations(
  checkpoint: ParsedCheckpoint,
  iterationPath: NonNullable<
    z.output<typeof loadInputsSchema>['lease']['iterationPath']
  >,
  branchPath: NonNullable<
    z.output<typeof loadInputsSchema>['lease']['branchPath']
  >,
) {
  const loopsByIdAndAncestry = new Map<
    string,
    Map<string, StructuredLoopDeclaration[]>
  >();
  for (const loop of checkpoint.loops) {
    let byAncestry = loopsByIdAndAncestry.get(loop.loopId);
    if (byAncestry === undefined) {
      byAncestry = new Map();
      loopsByIdAndAncestry.set(loop.loopId, byAncestry);
    }
    const ancestryKey = serializeStoredExecutionJsonValue(loop.iterationPath);
    const candidates = byAncestry.get(ancestryKey);
    if (candidates === undefined) byAncestry.set(ancestryKey, [loop]);
    else candidates.push(loop);
  }
  return iterationPath.map((scope, index) => {
    const enclosingIterationPath = iterationPath.slice(0, index);
    const ancestryKey = serializeStoredExecutionJsonValue(
      enclosingIterationPath,
    );
    const matches = (
      loopsByIdAndAncestry.get(scope.loopNodeId)?.get(ancestryKey) ?? []
    ).filter(
      (loop) =>
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
}

function projectStructuredCollection(
  loop: ParsedCheckpoint['loops'][number],
  scope: NonNullable<
    z.output<typeof loadInputsSchema>['lease']['iterationPath']
  >[number],
  rows: readonly LoopDeclarationRow[],
): NonNullable<NodeAttemptInputs['structuredCollection']> {
  const declarationRow = rows[0];
  if (
    rows.length !== 1 ||
    declarationRow?.node_id !== loop.loopId ||
    loop.collection.kind !== 'inline' ||
    loop.collection.attemptId !== declarationRow.attempt_id ||
    serializeStoredExecutionJsonValue(declarationRow.node_output_ref) !==
      serializeStoredExecutionJsonValue(declarationRow.attempt_output_ref)
  )
    throw new NodeAttemptStateCorruptError();
  const stored = parseStoredExecutionValueV1(declarationRow.attempt_output_ref);
  if (
    stored.kind !== 'inline' ||
    stored.value === null ||
    Array.isArray(stored.value) ||
    typeof stored.value !== 'object'
  )
    throw new NodeAttemptStateCorruptError();
  const declarationOutput = stored.value as Readonly<Record<string, unknown>>;
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
    loop.collectionSize !== items.length ||
    scope.ordinal < 0 ||
    scope.ordinal >= items.length ||
    loop.collectionChecksum !== collectionChecksum
  )
    throw new NodeAttemptStateCorruptError();
  return Object.freeze({
    loopNodeId: loop.loopId,
    ordinal: scope.ordinal,
    collection: items,
    collectionSize: loop.collectionSize,
    declaredCollectionChecksum: loop.collectionChecksum,
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
      const coordinatorInput = projectCoordinatorInput(
        checkpoint,
        input.lease.invocationKey,
      );
      let structuredCollection:
        NonNullable<NodeAttemptInputs['structuredCollection']> | undefined;
      const iterationPath = input.lease.iterationPath ?? [];
      if (iterationPath.length > 0) {
        const branchPath = input.lease.branchPath ?? [];
        const declaredLoops = selectStructuredLoopDeclarations(
          checkpoint,
          iterationPath,
          branchPath,
        );
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
        structuredCollection = projectStructuredCollection(
          nearestLoop,
          nearestScope,
          declaration.rows,
        );
      }
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
