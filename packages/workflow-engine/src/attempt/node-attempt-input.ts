import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { NODE_JSON_LIMITS_V1 } from '@pertexo/node-sdk';

import {
  canonicalJson,
  type JsonValue,
} from '@pertexo/workflow-model/canonical-json';

import { findExecutableNodeContext } from '../compilation/executable-graph.js';
import { freezeExecutable } from '../compilation/executable-foundation.js';
import {
  normalizeBoundedEngineJson,
  type WorkflowExecutableGraphV2,
  type WorkflowExecutableNodeV2,
} from '../executable-workflow.js';
import { exactKeys, operationError, record } from '../operation-values.js';
import type { ExecuteNodeAttemptInput } from './node-attempt-contract.js';
import { invocationKey as createInvocationKey } from '../transition/scheduling.js';

export type PreparedNodeAttemptInput = Readonly<{
  completedOutputs: Readonly<Record<string, JsonValue>>;
  directUpstream: ReadonlySet<string>;
  node: WorkflowExecutableNodeV2;
  runInput: JsonValue;
  structuredInputs?: Readonly<Record<string, JsonValue>>;
}>;

function assertStructuredScope(
  input: ExecuteNodeAttemptInput,
  ancestors: readonly string[],
): void {
  if (
    ancestors.length !== (input.iterationPath?.length ?? 0) ||
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
    const outputs = Object.create(null) as Record<string, JsonValue>;
    const canonicalByNodeId = new Map<string, string>();
    for (const candidate of completed as readonly JsonValue[]) {
      const [nodeId, value] = parseCompletedDescriptor(
        candidate,
        input,
        node,
        graph,
        directUpstream,
      );
      retainCompletedOutput(outputs, canonicalByNodeId, nodeId, value);
    }
    return outputs;
  }
  if (
    (input.iterationPath?.length ?? 0) > 0 ||
    (input.executable.envelope.schemaVersion === 3 &&
      (input.branchPath?.length ?? 0) > 0)
  ) {
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

function retainCompletedOutput(
  outputs: Record<string, JsonValue>,
  canonicalByNodeId: Map<string, string>,
  nodeId: string,
  value: JsonValue,
): void {
  const canonicalValue = canonicalJson(value);
  const existing = canonicalByNodeId.get(nodeId);
  if (existing !== undefined && existing !== canonicalValue)
    operationError('attempt_invalid', 'completed outputs conflict');
  if (existing === undefined) {
    canonicalByNodeId.set(nodeId, canonicalValue);
    outputs[nodeId] = value;
  }
}

/** Inspect metadata containers only; their values have independent JSON budgets. */
function ownCompletedFields(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || nodeTypes.isProxy(value))
    operationError('attempt_invalid', 'completed output metadata is invalid');
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    (prototype !== null &&
      prototype !== (array ? Array.prototype : Object.prototype)) ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    operationError('attempt_invalid', 'completed output metadata is invalid');
  const names = Object.getOwnPropertyNames(value);
  const length: unknown = array
    ? Object.getOwnPropertyDescriptor(value, 'length')?.value
    : undefined;
  if (
    names.length > NODE_JSON_LIMITS_V1.members + (array ? 1 : 0) ||
    (array &&
      (typeof length !== 'number' ||
        !Number.isSafeInteger(length) ||
        length > NODE_JSON_LIMITS_V1.members ||
        names.length !== length + 1))
  )
    operationError(
      'attempt_invalid',
      'completed output metadata exceeds limits',
    );
  for (const name in value)
    if (!Object.hasOwn(value, name))
      operationError(
        'attempt_invalid',
        'completed output metadata is inherited',
      );
  const fields = Object.create(null) as Record<string, unknown>;
  let ordinal = 0;
  for (const name of names) {
    if (array && name === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      (array && name !== String(ordinal++))
    )
      operationError('attempt_invalid', 'completed output metadata is invalid');
    fields[name] = descriptor.value;
  }
  return fields;
}

function normalizeCompletedOutputsV3(
  value: unknown,
  input: ExecuteNodeAttemptInput,
  node: WorkflowExecutableNodeV2,
  graph: WorkflowExecutableGraphV2,
  directUpstream: ReadonlySet<string>,
): Readonly<Record<string, JsonValue>> {
  const fields = ownCompletedFields(value);
  const outputs = Object.create(null) as Record<string, JsonValue>;
  if (!Array.isArray(value)) {
    const keys = Object.keys(fields);
    normalizeBoundedEngineJson(keys);
    parseCompletedOutputs(
      Object.fromEntries(keys.map((key) => [key, null])),
      input,
      node,
      graph,
      directUpstream,
    );
    for (const [nodeId, source] of Object.entries(fields))
      outputs[nodeId] = normalizeBoundedEngineJson(source);
    return freezeExecutable(outputs);
  }
  const descriptors = Object.values(fields).map((candidate) => {
    if (Array.isArray(candidate))
      operationError('attempt_invalid', 'completed output must be an object');
    const descriptor = ownCompletedFields(candidate);
    if (
      Object.keys(descriptor).length !== 3 ||
      !['invocationKey', 'nodeId', 'value'].every((key) =>
        Object.hasOwn(descriptor, key),
      )
    )
      operationError('attempt_invalid', 'observation fields are invalid');
    return descriptor;
  });
  // Bound aggregate metadata independently, never the source-value wrapper.
  const metadata = normalizeBoundedEngineJson(
    descriptors.map(({ nodeId, invocationKey }) => ({ nodeId, invocationKey })),
  );
  if (!Array.isArray(metadata))
    operationError('attempt_invalid', 'completed output metadata is invalid');
  // Validate every scoped source identity before inspecting any source value.
  const sources = descriptors.map((descriptor, index) => {
    const candidate = record(
      (metadata as readonly JsonValue[])[index] ?? null,
      'attempt_invalid',
      'completed output metadata',
    );
    const [nodeId] = parseCompletedDescriptor(
      { ...candidate, value: null },
      input,
      node,
      graph,
      directUpstream,
    );
    return [nodeId, descriptor.value] as const;
  });
  const canonicalByNodeId = new Map<string, string>();
  for (const [nodeId, source] of sources) {
    // Do not retain an independently cloned value for every duplicate descriptor.
    const normalized = normalizeBoundedEngineJson(source);
    retainCompletedOutput(outputs, canonicalByNodeId, nodeId, normalized);
  }
  return freezeExecutable(outputs);
}

function parseStructuredInputs(
  input: ExecuteNodeAttemptInput,
): Readonly<Record<string, JsonValue>> | undefined {
  const iterationPath = input.iterationPath;
  if (iterationPath === undefined || iterationPath.length === 0)
    return undefined;
  const nearest = iterationPath.at(-1);
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
  let completed: JsonValue = null;
  try {
    runInput = normalizeBoundedEngineJson(input.runInput);
    if (input.executable.envelope.schemaVersion !== 3)
      completed = normalizeBoundedEngineJson(input.completedNodeOutputs);
  } catch (error) {
    operationError(
      'attempt_invalid',
      error instanceof Error ? error.message : 'attempt input is invalid',
    );
  }
  const context = findExecutableNodeContext(
    input.executable.envelope.graph,
    input.nodeId,
  );
  if (context === undefined || context.node.disabled) {
    operationError('attempt_invalid', 'node is not executable');
  }
  const { node, graph: containingGraph, ancestors } = context;
  assertStructuredScope(input, ancestors);
  if (input.invocationKey !== expectedInvocationKey(input, node.id)) {
    operationError(
      'attempt_invalid',
      'node invocation identity does not match',
    );
  }
  const directUpstream = new Set(
    containingGraph.edges
      .filter(({ target }) => target.nodeId === node.id)
      .map(({ source }) => source.nodeId),
  );
  const structuredInputs = parseStructuredInputs(input);
  let completedOutputs: Readonly<Record<string, JsonValue>>;
  if (input.executable.envelope.schemaVersion === 3) {
    try {
      completedOutputs = normalizeCompletedOutputsV3(
        input.completedNodeOutputs,
        input,
        node,
        containingGraph,
        directUpstream,
      );
    } catch (error) {
      operationError(
        'attempt_invalid',
        error instanceof Error ? error.message : 'attempt input is invalid',
      );
    }
  } else {
    completedOutputs = parseCompletedOutputs(
      completed,
      input,
      node,
      containingGraph,
      directUpstream,
    );
  }
  return {
    node,
    runInput,
    directUpstream,
    completedOutputs,
    ...(structuredInputs === undefined ? {} : { structuredInputs }),
  };
}
