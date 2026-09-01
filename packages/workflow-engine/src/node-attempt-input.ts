import { createHash } from 'node:crypto';

import {
  canonicalJson,
  type JsonValue,
} from '@pertexo/workflow-model/canonical-json';

import { executableNodes } from './executable-graph.js';
import {
  normalizeBoundedEngineJson,
  type WorkflowExecutableGraphV2,
  type WorkflowExecutableNodeV2,
} from './executable-workflow.js';
import { exactKeys, operationError, record } from './operation-values.js';
import type { ExecuteNodeAttemptInput } from './operations.js';
import { invocationKey as createInvocationKey } from './scheduling.js';

export type PreparedNodeAttemptInput = Readonly<{
  completedOutputs: Readonly<Record<string, JsonValue>>;
  directUpstream: ReadonlySet<string>;
  node: WorkflowExecutableNodeV2;
  runInput: JsonValue;
  structuredInputs?: Readonly<Record<string, JsonValue>>;
}>;

function graphContainingNode(
  graph: WorkflowExecutableGraphV2,
  nodeId: string,
): WorkflowExecutableGraphV2 | undefined {
  if (graph.nodes.some(({ id }) => id === nodeId)) return graph;
  for (const node of graph.nodes) {
    if (node.structured === undefined) continue;
    const found = graphContainingNode(node.structured.body, nodeId);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function structuredAncestors(
  graph: WorkflowExecutableGraphV2,
  nodeId: string,
  ancestors: readonly string[] = [],
): readonly string[] | undefined {
  if (graph.nodes.some(({ id }) => id === nodeId)) return ancestors;
  for (const node of graph.nodes) {
    if (node.structured === undefined) continue;
    const found = structuredAncestors(node.structured.body, nodeId, [
      ...ancestors,
      node.id,
    ]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function assertStructuredScope(
  input: ExecuteNodeAttemptInput,
  node: WorkflowExecutableNodeV2,
): void {
  const ancestors = structuredAncestors(
    input.executable.envelope.graph,
    node.id,
  );
  if (
    ancestors?.length !== (input.iterationPath?.length ?? 0) ||
    ancestors.some(
      (loopNodeId, index) =>
        input.iterationPath?.[index]?.loopNodeId !== loopNodeId,
    )
  ) {
    operationError(
      'attempt_invalid',
      'node invocation structured scope does not match the executable',
    );
  }
}

function expectedInvocationKey(
  input: ExecuteNodeAttemptInput,
  nodeId: string,
): string {
  return createInvocationKey({
    workflowVersionId: input.workflowVersionId,
    nodeId,
    ...(input.branchPath === undefined
      ? {}
      : {
          branchPath: input.branchPath.map(
            ({ nodeId: branchNodeId, outputPort }) =>
              `${branchNodeId}:${outputPort}`,
          ),
        }),
    ...(input.iterationPath === undefined
      ? {}
      : { iterationPath: input.iterationPath }),
  });
}

function parseCompletedDescriptor(
  candidate: JsonValue,
  input: ExecuteNodeAttemptInput,
  node: WorkflowExecutableNodeV2,
  graph: WorkflowExecutableGraphV2,
  directUpstream: ReadonlySet<string>,
): readonly [string, JsonValue] {
  const descriptor = record(candidate, 'attempt_invalid', 'completed output');
  exactKeys(
    descriptor,
    ['invocationKey', 'nodeId', 'value'],
    [],
    'attempt_invalid',
  );
  const upstreamEdge = graph.edges.find(
    ({ source, target }) =>
      source.nodeId === descriptor.nodeId && target.nodeId === node.id,
  );
  const branchPath = input.branchPath ?? [];
  const nearestBranch = branchPath.at(-1);
  const upstreamBranchPath =
    upstreamEdge !== undefined &&
    nearestBranch?.nodeId === descriptor.nodeId &&
    nearestBranch?.outputPort === upstreamEdge.source.port
      ? branchPath.slice(0, -1)
      : branchPath;
  const expectedKey =
    typeof descriptor.nodeId === 'string'
      ? createInvocationKey({
          workflowVersionId: input.workflowVersionId,
          nodeId: descriptor.nodeId,
          branchPath: upstreamBranchPath.map(
            ({ nodeId: branchNodeId, outputPort }) =>
              `${branchNodeId}:${outputPort}`,
          ),
          ...(input.iterationPath === undefined
            ? {}
            : { iterationPath: input.iterationPath }),
        })
      : undefined;
  if (
    typeof descriptor.nodeId !== 'string' ||
    typeof descriptor.invocationKey !== 'string' ||
    !directUpstream.has(descriptor.nodeId) ||
    upstreamEdge === undefined ||
    descriptor.invocationKey !== expectedKey
  ) {
    operationError(
      'attempt_invalid',
      'completed output invocation is not exact upstream',
    );
  }
  if (descriptor.value === undefined) {
    operationError('attempt_invalid', 'completed output value is missing');
  }
  return [descriptor.nodeId, descriptor.value];
}

function parseCompletedOutputs(
  completed: JsonValue,
  input: ExecuteNodeAttemptInput,
  node: WorkflowExecutableNodeV2,
  graph: WorkflowExecutableGraphV2,
  directUpstream: ReadonlySet<string>,
): Readonly<Record<string, JsonValue>> {
  if (Array.isArray(completed)) {
    const outputs: Record<string, JsonValue> = {};
    for (const candidate of completed as readonly JsonValue[]) {
      const [nodeId, value] = parseCompletedDescriptor(
        candidate,
        input,
        node,
        graph,
        directUpstream,
      );
      outputs[nodeId] = value;
    }
    return outputs;
  }
  if ((input.iterationPath?.length ?? 0) > 0) {
    operationError(
      'attempt_invalid',
      'scoped completed outputs require invocation descriptors',
    );
  }
  const legacy = record(completed, 'attempt_invalid', 'completed outputs');
  for (const nodeId of Object.keys(legacy)) {
    if (!directUpstream.has(nodeId)) {
      operationError(
        'attempt_invalid',
        'completed output is not direct upstream',
      );
    }
  }
  return legacy;
}

function parseStructuredInputs(
  input: ExecuteNodeAttemptInput,
): Readonly<Record<string, JsonValue>> | undefined {
  if (input.iterationPath === undefined) return undefined;
  const nearest = input.iterationPath.at(-1);
  const proof = input.structuredCollection;
  if (proof === undefined || nearest === undefined) {
    operationError('attempt_invalid', 'structured collection proof is missing');
  }
  let collection: JsonValue;
  try {
    collection = normalizeBoundedEngineJson(proof.collection);
  } catch {
    operationError('attempt_invalid', 'structured collection is invalid');
  }
  if (!Array.isArray(collection)) {
    operationError('attempt_invalid', 'structured collection must be an array');
  }
  const items = collection as readonly JsonValue[];
  const validProof =
    proof.loopNodeId === nearest.loopNodeId &&
    Number.isSafeInteger(proof.ordinal) &&
    proof.ordinal === nearest.ordinal &&
    Number.isSafeInteger(proof.collectionSize) &&
    proof.collectionSize === items.length &&
    nearest.ordinal >= 0 &&
    nearest.ordinal < items.length &&
    typeof proof.declaredCollectionChecksum === 'string' &&
    createHash('sha256').update(canonicalJson(items)).digest('hex') ===
      proof.declaredCollectionChecksum;
  if (!validProof) {
    operationError('attempt_invalid', 'structured collection proof is invalid');
  }
  const item = items[nearest.ordinal];
  if (item === undefined) {
    operationError('attempt_invalid', 'structured collection item is missing');
  }
  return { item, ordinal: nearest.ordinal };
}

export function prepareNodeAttemptInput(
  input: ExecuteNodeAttemptInput,
): PreparedNodeAttemptInput {
  let runInput: JsonValue;
  let completed: JsonValue;
  try {
    runInput = normalizeBoundedEngineJson(input.runInput);
    completed = normalizeBoundedEngineJson(input.completedNodeOutputs);
  } catch (error) {
    operationError(
      'attempt_invalid',
      error instanceof Error ? error.message : 'attempt input is invalid',
    );
  }
  const node = executableNodes(input.executable.envelope.graph).find(
    ({ id }) => id === input.nodeId,
  );
  if (node === undefined || node.disabled) {
    operationError('attempt_invalid', 'node is not executable');
  }
  assertStructuredScope(input, node);
  if (input.invocationKey !== expectedInvocationKey(input, node.id)) {
    operationError(
      'attempt_invalid',
      'node invocation identity does not match',
    );
  }
  const containingGraph = graphContainingNode(
    input.executable.envelope.graph,
    node.id,
  );
  if (containingGraph === undefined) {
    operationError('attempt_invalid', 'node graph is missing');
  }
  const directUpstream = new Set(
    containingGraph.edges
      .filter(({ target }) => target.nodeId === node.id)
      .map(({ source }) => source.nodeId),
  );
  const structuredInputs = parseStructuredInputs(input);
  return {
    node,
    runInput,
    directUpstream,
    completedOutputs: parseCompletedOutputs(
      completed,
      input,
      node,
      containingGraph,
      directUpstream,
    ),
    ...(structuredInputs === undefined ? {} : { structuredInputs }),
  };
}
