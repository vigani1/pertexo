import { isPendingTaskNode } from '@pertexo/workflow-model';
import { assertFailureCheckpoint } from '../failure-routing/checkpoint.js';
import { isWorkflowCallDefinition } from '@pertexo/workflow-model';
import type { parseCheckpoint } from './create-and-parse.js';
import { findExecutableNodeContext } from '../compilation/graph.js';
import type {
  CompiledWorkflowExecutable,
  ExecutionNode,
} from '../compilation/foundation.js';
import {
  configuredParallelOutputPorts,
  configuredScopedOutputPorts,
} from '../transition/scheduling/readiness.js';
import { operationError } from '../operation-values.js';
import { compareOrdinal } from '@pertexo/workflow-model';
import { branchPathHasPrefix, sameIterationPath } from '../scope.js';
import { invocationKey as createInvocationKey } from '../transition/scheduling/loops.js';

type ParsedCheckpoint = ReturnType<typeof parseCheckpoint>;
type CheckpointJoin = ParsedCheckpoint['joins'][number];
type CheckpointInvocation = ParsedCheckpoint['invocations'][number];
type CheckpointLoop = ParsedCheckpoint['loops'][number];

function assertCheckpointJoinIdentity(
  join: CheckpointJoin,
  checkpoint: ParsedCheckpoint,
  nodesById: ReadonlyMap<string, ExecutionNode>,
): void {
  const merge = nodesById.get(join.joinId);
  if (merge?.control?.kind !== 'merge')
    operationError(
      'workflow_identity_invalid',
      'checkpoint join does not belong to a Merge node',
    );
  const parallel = nodesById.get(merge.control.config.parallelNodeId);
  const branchIds =
    parallel === undefined
      ? undefined
      : configuredParallelOutputPorts(parallel);
  if (branchIds === undefined)
    operationError(
      'workflow_identity_invalid',
      'checkpoint join disagrees with its paired Parallel',
    );
  const ledgerMatchesParallel =
    join.ledger.length === branchIds.length &&
    join.ledger.every(({ branchId }) => branchIds.includes(branchId));
  if (!ledgerMatchesParallel)
    operationError(
      'workflow_identity_invalid',
      'checkpoint join disagrees with its paired Parallel',
    );
  const expectedJoinKey = createInvocationKey({
    workflowVersionId: checkpoint.workflowVersionId,
    nodeId: join.joinId,
    branchPath: (join.branchPath ?? []).map(
      ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
    ),
    ...(join.iterationPath === undefined
      ? {}
      : { iterationPath: join.iterationPath }),
  });
  if (join.joinInvocationKey !== expectedJoinKey)
    operationError(
      'workflow_identity_invalid',
      'checkpoint join scope is invalid',
    );
}

function expectedInvocationKey(
  invocation: CheckpointInvocation,
  workflowVersionId: string,
): string {
  const branchPath = invocation.branchPath ?? [];
  return createInvocationKey({
    workflowVersionId,
    nodeId: invocation.nodeId,
    branchPath: branchPath.map(
      ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
    ),
    ...(invocation.iterationPath === undefined
      ? {}
      : { iterationPath: invocation.iterationPath }),
  });
}

function assertInvocationBelongsToExecutable(
  invocation: CheckpointInvocation,
  {
    checkpoint,
    executable,
    nodeIds,
    nodesById,
  }: Readonly<{
    checkpoint: ParsedCheckpoint;
    executable: CompiledWorkflowExecutable;
    nodeIds: ReadonlySet<string>;
    nodesById: ReadonlyMap<string, ExecutionNode>;
  }>,
): void {
  const invalidInvocationIdentity = (): never =>
    operationError(
      'workflow_identity_invalid',
      'checkpoint invocation does not belong to the executable graph',
    );
  if (!nodeIds.has(invocation.nodeId)) invalidInvocationIdentity();
  const invalidCallOwner =
    (invocation.waitKind === 'workflow_call' ||
      invocation.output?.kind === 'call') &&
    !isWorkflowCallDefinition(nodesById.get(invocation.nodeId)?.definition);
  if (invalidCallOwner) invalidInvocationIdentity();
  const invalidTaskOwner =
    (invocation.waitKind === 'human_task' ||
      invocation.output?.kind === 'task') &&
    !isPendingTaskNode(nodesById.get(invocation.nodeId));
  if (invalidTaskOwner) invalidInvocationIdentity();
  const branchPath = invocation.branchPath ?? [];
  const ancestors = findExecutableNodeContext(
    executable.envelope.graph,
    invocation.nodeId,
  )?.ancestors;
  if (
    ancestors?.length !== (invocation.iterationPath?.length ?? 0) ||
    ancestors.some(
      (loopNodeId, index) =>
        invocation.iterationPath?.[index]?.loopNodeId !== loopNodeId,
    )
  )
    invalidInvocationIdentity();
  if (
    branchPath.some(({ nodeId, outputPort }) => {
      const node = nodesById.get(nodeId);
      const outputPorts =
        node === undefined ? undefined : configuredScopedOutputPorts(node);
      return !outputPorts?.includes(outputPort);
    })
  )
    invalidInvocationIdentity();
  if (
    invocation.invocationKey ===
    expectedInvocationKey(invocation, checkpoint.workflowVersionId)
  )
    return;
  invalidInvocationIdentity();
}

function assertInvocationIterationScopes(
  invocation: CheckpointInvocation,
  checkpoint: ParsedCheckpoint,
): void {
  const branchPath = invocation.branchPath ?? [];
  for (const [index, scope] of (invocation.iterationPath ?? []).entries()) {
    const enclosingPath = invocation.iterationPath?.slice(0, index) ?? [];
    const declaredLoop = checkpoint.loops.find(
      (loop) =>
        loop.loopId === scope.loopNodeId &&
        sameIterationPath(loop.iterationPath, enclosingPath) &&
        branchPathHasPrefix(branchPath, loop.branchPath),
    );
    const ordinalIsDeclared =
      declaredLoop !== undefined &&
      (declaredLoop.activeOrdinals.includes(scope.ordinal) ||
        declaredLoop.terminalOrdinals.includes(scope.ordinal));
    if (!ordinalIsDeclared)
      operationError(
        'workflow_identity_invalid',
        'checkpoint invocation iteration scope is not active in its declared loop',
      );
  }
}

function assertCheckpointLoopIdentity(
  loop: CheckpointLoop,
  checkpoint: ParsedCheckpoint,
  nodesById: ReadonlyMap<string, ExecutionNode>,
): void {
  const node = nodesById.get(loop.loopId);
  const controlIdentityMatches =
    node?.definition.key === 'core.foreach' &&
    node.definition.version === 1 &&
    node.structured?.kind === 'for_each' &&
    loop.controlInvocationKey ===
      createInvocationKey({
        workflowVersionId: checkpoint.workflowVersionId,
        nodeId: loop.loopId,
        branchPath: loop.branchPath.map(
          ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
        ),
        iterationPath: loop.iterationPath,
      });
  if (!controlIdentityMatches)
    operationError(
      'workflow_identity_invalid',
      'checkpoint loop does not belong to its scoped For Each control',
    );
  const body = node.structured.body;
  const targets = new Set(body.edges.map(({ target }) => target.nodeId));
  const sources = new Set(body.edges.map(({ source }) => source.nodeId));
  const expectedRoots = body.nodes
    .map(({ id }) => id)
    .filter((id) => !targets.has(id))
    .sort(compareOrdinal);
  const expectedSink = body.nodes.find(({ id }) => !sources.has(id))?.id;
  const loopTopologyMismatch =
    loop.maxIterations !== node.structured.maxIterations ||
    loop.maxConcurrency !== node.structured.maxConcurrency ||
    loop.bodyRootNodeIds.length !== expectedRoots.length ||
    loop.bodyRootNodeIds.some((id, index) => id !== expectedRoots[index]) ||
    loop.bodySinkNodeId !== expectedSink;
  if (loopTopologyMismatch)
    operationError(
      'workflow_identity_invalid',
      'checkpoint loop topology or bounds disagree with the executable',
    );
}

export function assertCheckpointMatchesExecutable(
  checkpoint: ParsedCheckpoint,
  executable: CompiledWorkflowExecutable,
  allNodes: readonly ExecutionNode[],
): void {
  const nodeIds = new Set(allNodes.map(({ id }) => id));
  const nodesById = new Map(allNodes.map((node) => [node.id, node]));
  assertFailureCheckpoint(checkpoint, executable);
  for (const join of checkpoint.joins)
    assertCheckpointJoinIdentity(join, checkpoint, nodesById);
  const invocationKeys = new Set<string>();
  for (const invocation of checkpoint.invocations) {
    assertInvocationBelongsToExecutable(invocation, {
      checkpoint: checkpoint,
      executable: executable,
      nodeIds: nodeIds,
      nodesById: nodesById,
    });
    assertInvocationIterationScopes(invocation, checkpoint);
    invocationKeys.add(invocation.invocationKey);
  }
  if (
    checkpoint.admittedInvocationKeys.some(
      (invocationKey) => !invocationKeys.has(invocationKey),
    )
  )
    operationError(
      'workflow_identity_invalid',
      'checkpoint admission does not belong to an executable invocation',
    );
  for (const loop of checkpoint.loops)
    assertCheckpointLoopIdentity(loop, checkpoint, nodesById);
}
