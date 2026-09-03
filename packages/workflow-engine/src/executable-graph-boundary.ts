import type { RegistryRelease } from '@pertexo/node-sdk';
import { canonicalJson } from '@pertexo/workflow-model/canonical-json';
import type {
  WorkflowGraph,
  WorkflowNode,
} from '@pertexo/workflow-model/graph';
import { graphValidationIndex } from './executable-graph-validation-index.js';
import {
  assertBranchesDoNotReconverge,
  assertExpressionPolicies,
  assertGraphPorts,
  canonicalEdges,
  definitionManifest,
  executorManifest,
} from './executable-compilation.js';
import {
  type WorkflowExecutableGraphV2,
  type WorkflowExecutableNodeV2,
  compareIdentity,
  compareOrdinal,
  fail,
  sameIdentity,
} from './executable-foundation.js';
import {
  exactKeys,
  immutableDefinitionBehavior,
  immutableExecutorBehavior,
  parseIdentity,
  parsePolicies,
  parseSideEffectClass,
  record,
  sideEffectClass,
} from './executable-validation.js';

export interface RawExecutableNodeV2 {
  readonly raw: Record<string, unknown>;
  readonly structured?: {
    readonly raw: Record<string, unknown>;
    readonly body: RawExecutableGraphV2;
  };
}

export interface RawExecutableGraphV2 {
  readonly raw: Record<string, unknown>;
  readonly nodes: readonly RawExecutableNodeV2[];
  readonly body: boolean;
}

export function readRawExecutableGraph(
  value: unknown,
  body: boolean,
): RawExecutableGraphV2 {
  const raw = record(
    value,
    body ? 'executable structured body' : 'executable graph',
  );
  exactKeys(
    raw,
    body
      ? ['settings', 'nodes', 'edges', 'inputPorts', 'outputPorts']
      : ['settings', 'nodes', 'edges'],
  );
  if (!Array.isArray(raw.nodes)) fail('executable nodes must be an array');
  const nodes = raw.nodes.map((value, index): RawExecutableNodeV2 => {
    const node = record(value, `executable node ${String(index)}`);
    exactKeys(
      node,
      [
        'id',
        'definition',
        'configVersion',
        'config',
        'inputMappings',
        'connectionRefs',
        'disabled',
        'sideEffectClass',
        'executor',
        'executorAbi',
        'policyReferences',
      ],
      ['structured'],
    );
    if (node.structured === undefined) return { raw: node };
    const structured = record(node.structured, 'executable For Each structure');
    exactKeys(structured, ['kind', 'maxIterations', 'maxConcurrency', 'body']);
    return {
      raw: node,
      structured: {
        raw: structured,
        body: readRawExecutableGraph(structured.body, true),
      },
    };
  });
  return { raw, nodes, body };
}

function authoringNode(node: RawExecutableNodeV2): unknown {
  const raw = node.raw;
  const authoring: Record<string, unknown> = {
    id: raw.id,
    definition: raw.definition,
    position: { x: 0, y: 0 },
    configVersion: raw.configVersion,
    config: raw.config,
    inputMappings: raw.inputMappings,
    connectionRefs: raw.connectionRefs,
    disabled: raw.disabled,
  };
  if (node.structured !== undefined) {
    authoring.structured = {
      kind: node.structured.raw.kind,
      maxIterations: node.structured.raw.maxIterations,
      maxConcurrency: node.structured.raw.maxConcurrency,
      body: authoringGraph(node.structured.body),
    };
  }
  return authoring;
}

export function authoringGraph(tree: RawExecutableGraphV2): unknown {
  return {
    schemaVersion: 1,
    settings: tree.raw.settings,
    nodes: tree.nodes.map(authoringNode),
    edges: tree.raw.edges,
    ...(tree.body
      ? {
          inputPorts: tree.raw.inputPorts,
          outputPorts: tree.raw.outputPorts,
        }
      : {}),
  };
}

function validatePin(
  raw: Record<string, unknown>,
  node: WorkflowNode,
  admission: RegistryRelease,
  current: RegistryRelease,
  alreadyAdmitted: boolean,
): WorkflowExecutableNodeV2 {
  const definition = parseIdentity(raw.definition, 'node definition');
  const executor = parseIdentity(raw.executor, 'node executor');
  const policies = parsePolicies(raw.policyReferences);
  const selectedSideEffectClass = parseSideEffectClass(raw.sideEffectClass);
  const admissionDefinition = definitionManifest(admission, definition);
  const currentDefinition = definitionManifest(current, definition);
  const admissionExecutor = executorManifest(admission, executor);
  const currentExecutor = executorManifest(current, executor);
  const expectedPolicies = canonicalJson(policies);
  if (
    (admissionDefinition.lifecycle !== 'active' &&
      admissionDefinition.lifecycle !== 'deprecated') ||
    admissionExecutor.lifecycle !== 'active' ||
    canonicalJson(immutableDefinitionBehavior(admissionDefinition)) !==
      canonicalJson(immutableDefinitionBehavior(currentDefinition)) ||
    canonicalJson(immutableExecutorBehavior(admissionExecutor)) !==
      canonicalJson(immutableExecutorBehavior(currentExecutor)) ||
    !sameIdentity(node.definition, definition) ||
    !sameIdentity(admissionDefinition.executor, executor) ||
    !sameIdentity(currentDefinition.executor, executor) ||
    admissionDefinition.configVersion !== node.configVersion ||
    currentDefinition.configVersion !== node.configVersion ||
    raw.executorAbi !== admissionExecutor.abiVersion ||
    raw.executorAbi !== currentExecutor.abiVersion ||
    selectedSideEffectClass !==
      sideEffectClass(admissionDefinition.retryClass) ||
    selectedSideEffectClass !== sideEffectClass(currentDefinition.retryClass) ||
    expectedPolicies !==
      canonicalJson(
        [...admissionDefinition.policyReferences].sort(compareIdentity),
      ) ||
    expectedPolicies !==
      canonicalJson(
        [...currentDefinition.policyReferences].sort(compareIdentity),
      ) ||
    !currentExecutor.definitions.some((value) =>
      sameIdentity(value, definition),
    ) ||
    !(
      currentExecutor.lifecycle === 'active' ||
      currentExecutor.lifecycle === 'retained' ||
      (currentExecutor.lifecycle === 'retirement_blocked' && alreadyAdmitted)
    )
  )
    fail('node executable pins are incompatible');
  assertExpressionPolicies(node, policies);
  return {
    id: node.id,
    definition,
    configVersion: node.configVersion,
    config: node.config,
    inputMappings: node.inputMappings,
    connectionRefs: node.connectionRefs,
    disabled: node.disabled ?? false,
    sideEffectClass: selectedSideEffectClass,
    executor,
    executorAbi: admissionExecutor.abiVersion,
    policyReferences: policies,
  };
}

export function validateExecutableGraph(
  tree: RawExecutableGraphV2,
  graph: WorkflowGraph,
  admission: RegistryRelease,
  current: RegistryRelease,
  alreadyAdmitted: boolean,
): WorkflowExecutableGraphV2 {
  const index = graphValidationIndex(graph);
  assertGraphPorts(graph, admission, index);
  assertBranchesDoNotReconverge(graph, index);
  const parsedById = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodes = tree.nodes.map((rawNode) => {
    if (typeof rawNode.raw.id !== 'string') fail('node ID is invalid');
    const node = parsedById.get(rawNode.raw.id);
    if (node === undefined) fail('node is absent from parsed graph');
    const executable = validatePin(
      rawNode.raw,
      node,
      admission,
      current,
      alreadyAdmitted,
    );
    if (rawNode.structured === undefined && node.structured === undefined)
      return executable;
    if (rawNode.structured === undefined || node.structured === undefined)
      fail('For Each executable structure does not match its graph');
    const body = validateExecutableGraph(
      rawNode.structured.body,
      node.structured.body,
      admission,
      current,
      alreadyAdmitted,
    );
    return {
      ...executable,
      structured: {
        kind: 'for_each' as const,
        maxIterations: node.structured.maxIterations,
        maxConcurrency: node.structured.maxConcurrency,
        body: {
          ...body,
          inputPorts: node.structured.body.inputPorts,
          outputPorts: node.structured.body.outputPorts,
        },
      },
    };
  });
  const sortedNodes = [...nodes].sort((left, right) =>
    compareOrdinal(left.id, right.id),
  );
  const sortedEdges = canonicalEdges(graph);
  if (
    canonicalJson(nodes) !== canonicalJson(sortedNodes) ||
    canonicalJson(graph.edges) !== canonicalJson(sortedEdges)
  )
    fail('executable graph is not canonically ordered');
  return { settings: graph.settings, nodes, edges: sortedEdges };
}
