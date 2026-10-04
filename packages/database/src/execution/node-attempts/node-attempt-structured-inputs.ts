import { createHash } from 'node:crypto';
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

type ParsedCheckpoint =
  | ReturnType<typeof parsePersistedWorkflowCheckpoint>
  | ReturnType<typeof parsePersistedWorkflowCheckpointV3>;
type StructuredLoopDeclaration = Extract<
  ParsedCheckpoint,
  { schemaVersion: 2 }
>['loops'][number];
type LoopDeclarationRow = Readonly<{
  attempt_id: string;
  attempt_output_ref: unknown;
  node_output_ref: unknown;
  node_id: string;
}>;

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

/** Resolve retained structured collection declarations on the current scoped client. */
export async function loadNodeAttemptStructuredCollection(
  client: PoolClient,
  input: z.output<typeof loadInputsSchema>,
  checkpoint: ParsedCheckpoint,
): Promise<NonNullable<NodeAttemptInputs['structuredCollection']> | undefined> {
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
  return structuredCollection;
}
