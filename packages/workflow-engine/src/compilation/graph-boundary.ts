import type { NodeCatalog } from '@pertexo/node-sdk';
import {
  canonicalJson,
  type WorkflowGraph,
  type WorkflowNode,
} from '@pertexo/workflow-model';
import { graphValidationIndex } from './graph-validation-index.js';
import {
  assertBranchesDoNotReconverge,
  assertExpressionPolicies,
  assertGraphPorts,
  canonicalEdges,
  definitionManifest,
  executorManifest,
} from './graph-rules.js';
import {
  type WorkflowExecutableGraph,
  type WorkflowExecutableNode,
  compareIdentity,
  compareOrdinal,
  fail,
  sameIdentity,
} from './foundation.js';
import {
  exactKeys,
  parseIdentity,
  parsePolicies,
  parseSideEffectClass,
  record,
  sideEffectClass,
} from './validation.js';

export interface RawExecutableNode {
  readonly raw: Record<string, unknown>;
  readonly structured?: {
    readonly raw: Record<string, unknown>;
    readonly body: RawExecutableGraph;
  };
}

export interface RawExecutableGraph {
  readonly raw: Record<string, unknown>;
  readonly nodes: readonly RawExecutableNode[];
  readonly body: boolean;
}

export function readRawExecutableGraph(
  value: unknown,
  body: boolean,
): RawExecutableGraph {
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
  const nodes = raw.nodes.map((value, index): RawExecutableNode => {
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

function authoringNode(node: RawExecutableNode): unknown {
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

export function authoringGraph(tree: RawExecutableGraph): unknown {
  return {
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
  catalog: NodeCatalog,
): WorkflowExecutableNode {
  const definition = parseIdentity(raw.definition, 'node definition');
  const executor = parseIdentity(raw.executor, 'node executor');
  const policies = parsePolicies(raw.policyReferences);
  const selectedSideEffectClass = parseSideEffectClass(raw.sideEffectClass);
  const definitionPin = definitionManifest(catalog, definition);
  const executorPin = executorManifest(catalog, executor);
  if (
    !executorPin.definitions.some((value) => sameIdentity(value, definition)) ||
    !sameIdentity(node.definition, definition) ||
    !sameIdentity(definitionPin.executor, executor) ||
    definitionPin.configVersion !== node.configVersion ||
    raw.executorAbi !== executorPin.abiVersion ||
    selectedSideEffectClass !== sideEffectClass(definitionPin.retryClass) ||
    canonicalJson(policies) !==
      canonicalJson([...definitionPin.policyReferences].sort(compareIdentity))
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
    executorAbi: executorPin.abiVersion,
    policyReferences: policies,
  };
}

export function validateExecutableGraph(
  tree: RawExecutableGraph,
  graph: WorkflowGraph,
  catalog: NodeCatalog,
): WorkflowExecutableGraph {
  const index = graphValidationIndex(graph);
  assertGraphPorts(graph, catalog, index);
  assertBranchesDoNotReconverge(graph, index);
  const parsedById = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodes = tree.nodes.map((rawNode) => {
    if (typeof rawNode.raw.id !== 'string') fail('node ID is invalid');
    const node = parsedById.get(rawNode.raw.id);
    if (node === undefined) fail('node is absent from parsed graph');
    const executable = validatePin(rawNode.raw, node, catalog);
    if (rawNode.structured === undefined && node.structured === undefined)
      return executable;
    if (rawNode.structured === undefined || node.structured === undefined)
      fail('For Each executable structure does not match its graph');
    const body = validateExecutableGraph(
      rawNode.structured.body,
      node.structured.body,
      catalog,
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
