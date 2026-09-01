import { canonicalJson } from './canonical-json.js';
import type {
  ForEachStructure,
  WorkflowGraph,
  WorkflowNode,
} from './graph-contract.js';
import type { GraphIssueCode, WorkflowGraphLimits } from './graph.js';

type Issue = (code: GraphIssueCode, path: string, message: string) => void;
interface Totals {
  readonly expanded: number;
  readonly iterations: number;
}
interface Aggregate {
  nodes: number;
  edges: number;
}
type ValidationContext = Readonly<{
  aggregate: Aggregate;
  allNodeIds: ReadonlySet<string>;
  globalNodeIds: Set<string>;
  issue: Issue;
  limits: WorkflowGraphLimits;
}>;

function isForEachStructure(value: unknown): value is ForEachStructure {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { readonly kind?: unknown }).kind === 'for_each'
  );
}

function indexLocalNodes(
  graph: WorkflowGraph,
  path: string,
  context: ValidationContext,
): ReadonlySet<string> {
  const localIds = new Set<string>();
  for (const node of graph.nodes) {
    if (localIds.has(node.id) || context.globalNodeIds.has(node.id)) {
      context.issue(
        'duplicate_node_id',
        `${path}.nodes`,
        `duplicate node ${node.id}`,
      );
    }
    localIds.add(node.id);
    context.globalNodeIds.add(node.id);
  }
  return localIds;
}

function validateMappings(
  graph: WorkflowGraph,
  path: string,
  localIds: ReadonlySet<string>,
  structuredInputPorts: ReadonlySet<string> | undefined,
  context: ValidationContext,
): void {
  for (const node of graph.nodes) {
    for (const [mappingKey, source] of Object.entries(node.inputMappings)) {
      const mappingPath = `${path}.nodes.${node.id}.inputMappings.${mappingKey}`;
      if (
        source.kind === 'structured_input' &&
        !structuredInputPorts?.has(source.port)
      ) {
        context.issue(
          'invalid_structured_body',
          mappingPath,
          'structured input must reference a port on the nearest body',
        );
      }
      if (
        source.kind === 'node_output' &&
        !localIds.has(source.nodeId) &&
        context.allNodeIds.has(source.nodeId)
      ) {
        context.issue(
          'invalid_structured_body',
          mappingPath,
          'node output mappings cannot cross a structured-body seam',
        );
      }
    }
  }
}

function validateEdges(
  graph: WorkflowGraph,
  path: string,
  localIds: ReadonlySet<string>,
  context: ValidationContext,
): ReadonlyMap<string, readonly string[]> {
  const edgeIds = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const id of localIds) adjacency.set(id, []);
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) {
      context.issue(
        'duplicate_edge_id',
        `${path}.edges`,
        `duplicate edge ${edge.id}`,
      );
    }
    edgeIds.add(edge.id);
    if (
      !localIds.has(edge.source.nodeId) ||
      !localIds.has(edge.target.nodeId)
    ) {
      context.issue(
        'dangling_edge',
        `${path}.edges.${edge.id}`,
        'ordinary edges cannot cross a structured-body seam',
      );
    } else {
      adjacency.get(edge.source.nodeId)?.push(edge.target.nodeId);
    }
  }
  return adjacency;
}

function validateAcyclic(
  adjacency: ReadonlyMap<string, readonly string[]>,
  path: string,
  issue: Issue,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      issue('cycle', path, `cycle contains ${id}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...adjacency.keys()].sort()) visit(id);
}

function validateLoopLimits(
  loop: ForEachStructure,
  path: string,
  context: ValidationContext,
): void {
  if (
    !Number.isInteger(loop.maxIterations) ||
    loop.maxIterations < 1 ||
    loop.maxIterations > context.limits.maxLoopIterations ||
    !Number.isInteger(loop.maxConcurrency) ||
    loop.maxConcurrency < 1 ||
    loop.maxConcurrency > loop.maxIterations ||
    loop.maxConcurrency > context.limits.maxLoopConcurrency
  ) {
    context.issue(
      'invalid_loop_limit',
      path,
      'For Each limits must be positive, bounded, and concurrency cannot exceed iterations',
    );
  }
}

function structuredBodyTopologyValid(body: WorkflowGraph): boolean {
  const bodyIds = new Set(body.nodes.map(({ id }) => id));
  const incoming = new Map([...bodyIds].map((id) => [id, 0]));
  const outgoing = new Map([...bodyIds].map((id) => [id, [] as string[]]));
  for (const edge of body.edges) {
    if (!bodyIds.has(edge.source.nodeId) || !bodyIds.has(edge.target.nodeId)) {
      continue;
    }
    incoming.set(
      edge.target.nodeId,
      (incoming.get(edge.target.nodeId) ?? 0) + 1,
    );
    outgoing.get(edge.source.nodeId)?.push(edge.target.nodeId);
  }
  const roots = [...bodyIds].filter((id) => incoming.get(id) === 0);
  const sinks = [...bodyIds].filter((id) => outgoing.get(id)?.length === 0);
  const reachable = traverse(roots, outgoing);
  const reverse = new Map([...bodyIds].map((id) => [id, [] as string[]]));
  for (const [source, targets] of outgoing) {
    for (const target of targets) reverse.get(target)?.push(source);
  }
  const reachesSink = traverse(sinks.length === 1 ? sinks : [], reverse);
  return (
    sinks.length === 1 &&
    reachable.size === bodyIds.size &&
    reachesSink.size === bodyIds.size
  );
}

function traverse(
  initial: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): ReadonlySet<string> {
  const reached = new Set<string>();
  const pending = [...initial];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || reached.has(id)) continue;
    reached.add(id);
    pending.push(...(edges.get(id) ?? []));
  }
  return reached;
}

function validateStructuredNode(
  node: WorkflowNode,
  path: string,
  context: ValidationContext,
): Totals {
  const ownsForEach =
    node.definition.key === 'core.foreach' && node.definition.version === 1;
  if (ownsForEach !== (node.structured !== undefined)) {
    context.issue(
      'invalid_structured_body',
      `${path}.structured`,
      'core.foreach@1 must own exactly one For Each body and no other definition may own one',
    );
  }
  if (node.structured === undefined) return { expanded: 1, iterations: 0 };
  const structured: unknown = node.structured;
  if (!isForEachStructure(structured)) {
    context.issue(
      'invalid_structured_body',
      `${path}.structured.kind`,
      'structured nodes must use kind for_each',
    );
    return { expanded: 1, iterations: 0 };
  }
  const loopPath = `${path}.structured`;
  const bodyPath = `${loopPath}.body`;
  validateLoopLimits(structured, loopPath, context);
  if (
    canonicalJson(structured.body.inputPorts) !==
      canonicalJson(['item', 'ordinal']) ||
    canonicalJson(structured.body.outputPorts) !== canonicalJson(['result'])
  ) {
    context.issue(
      'invalid_structured_body',
      bodyPath,
      'For Each body ports must be exactly item, ordinal, and result',
    );
  }
  if (structured.body.nodes.length === 0) {
    context.issue(
      'invalid_structured_body',
      `${bodyPath}.nodes`,
      'For Each body must not be empty',
    );
  }
  if (!structuredBodyTopologyValid(structured.body)) {
    context.issue(
      'invalid_structured_body',
      bodyPath,
      'For Each body requires one sink with every node root-reachable and sink-reachable',
    );
  }
  const body = validateGraphStructure(
    structured.body,
    bodyPath,
    context,
    new Set(structured.body.inputPorts),
  );
  const maxIterations = Math.max(0, structured.maxIterations);
  return {
    expanded: 1 + maxIterations * body.expanded,
    iterations: maxIterations * (1 + body.iterations),
  };
}

export function validateGraphStructure(
  graph: WorkflowGraph,
  path: string,
  context: ValidationContext,
  structuredInputPorts?: ReadonlySet<string>,
): Totals {
  if (graph.schemaVersion !== 1) {
    context.issue(
      'invalid_graph',
      `${path}.schemaVersion`,
      'schemaVersion must be exactly 1',
    );
  }
  context.aggregate.nodes += graph.nodes.length;
  context.aggregate.edges += graph.edges.length;
  if (
    context.aggregate.nodes > context.limits.nodes ||
    context.aggregate.edges > context.limits.edges
  ) {
    context.issue(
      'graph_limit',
      path,
      'node or edge count exceeds the graph limit',
    );
  }
  const localIds = indexLocalNodes(graph, path, context);
  validateMappings(graph, path, localIds, structuredInputPorts, context);
  validateAcyclic(
    validateEdges(graph, path, localIds, context),
    path,
    context.issue,
  );
  let expanded = 0;
  let iterations = 0;
  for (const node of graph.nodes) {
    const totals = validateStructuredNode(
      node,
      `${path}.nodes.${node.id}`,
      context,
    );
    expanded += totals.expanded;
    iterations += totals.iterations;
  }
  return { expanded, iterations };
}
