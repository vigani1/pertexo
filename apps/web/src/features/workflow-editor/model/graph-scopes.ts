import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';

// The nested-graph layer. A For each step owns its body (ADR 020): a graph
// of its own, stored inside the step. Every step and connection lives on
// one level, the workflow itself or a body, and a scope names that level by
// the For each steps above it. Commands change one level and write it back,
// so the rest of the workflow keeps its identity and a no-op stays a no-op.

export type WorkflowNode = WorkflowGraphContract['nodes'][number];
export type WorkflowEdge = WorkflowGraphContract['edges'][number];
type LoopStructure = NonNullable<WorkflowNode['structured']>;

/** One level of the workflow: the workflow itself or a For each body. */
export type GraphLevel = Readonly<{
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}>;

/** The For each steps from the workflow down to a level; [] is the workflow. */
export type ScopePath = readonly string[];

/** A change to one level that keeps whatever else that level carries. */
export type LevelChange = <Level extends GraphLevel>(level: Level) => Level;

type Located<Item> = Readonly<{ item: Item; scope: ScopePath }>;
type GraphIndex = Readonly<{
  nodes: ReadonlyMap<string, Located<WorkflowNode>>;
  edges: ReadonlyMap<string, Located<WorkflowEdge>>;
}>;

const FOR_EACH_KEY = 'core.foreach';
/** The exact ports every body has (ADR 020). */
export const BODY_PORTS = Object.freeze({
  inputs: Object.freeze(['item', 'ordinal']),
  outputs: Object.freeze(['result']),
});
/** Bounds a new For each starts with: one item at a time, up to 100. */
const DEFAULT_LOOP_BOUNDS = Object.freeze({
  maxIterations: 100,
  maxConcurrency: 1,
});

/** A For each step, drawn and inspected as a container for its body. */
export function isForEach(
  node: Pick<WorkflowNode, 'definition' | 'structured'>,
): boolean {
  return node.definition.key === FOR_EACH_KEY || node.structured !== undefined;
}

/** The structure a new For each owns: an empty body with default bounds. */
export function emptyLoopStructure(): LoopStructure {
  return {
    kind: 'for_each',
    ...DEFAULT_LOOP_BOUNDS,
    body: {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: {},
      inputPorts: [...BODY_PORTS.inputs],
      outputPorts: [...BODY_PORTS.outputs],
    },
  };
}

/** Visits the workflow and every body inside it, outermost first. */
export function walkLevels(
  graph: GraphLevel,
  visit: (level: GraphLevel, scope: ScopePath) => void,
  scope: ScopePath = [],
): void {
  visit(graph, scope);
  for (const node of graph.nodes)
    if (node.structured !== undefined)
      walkLevels(node.structured.body, visit, [...scope, node.id]);
}

const indexes = new WeakMap<GraphLevel, GraphIndex>();

/** Where every step and connection lives. Cached per (immutable) graph. */
export function indexGraph(graph: GraphLevel): GraphIndex {
  const cached = indexes.get(graph);
  if (cached !== undefined) return cached;
  const nodes = new Map<string, Located<WorkflowNode>>();
  const edges = new Map<string, Located<WorkflowEdge>>();
  walkLevels(graph, (level, scope) => {
    for (const node of level.nodes)
      if (!nodes.has(node.id)) nodes.set(node.id, { item: node, scope });
    for (const edge of level.edges)
      if (!edges.has(edge.id)) edges.set(edge.id, { item: edge, scope });
  });
  const index = { nodes, edges };
  indexes.set(graph, index);
  return index;
}

/** A step anywhere in the workflow, inside bodies too. */
export function findStep(
  graph: GraphLevel,
  nodeId: string,
): WorkflowNode | undefined {
  return indexGraph(graph).nodes.get(nodeId)?.item;
}

export function scopeOf(
  graph: GraphLevel,
  nodeId: string,
): ScopePath | undefined {
  return indexGraph(graph).nodes.get(nodeId)?.scope;
}

/** The level a scope names, or undefined when it no longer exists. */
export function levelAt(
  graph: GraphLevel,
  scope: ScopePath,
): GraphLevel | undefined {
  let level: GraphLevel | undefined = graph;
  for (const loopId of scope)
    level = level?.nodes.find((node) => node.id === loopId)?.structured?.body;
  return level;
}

/** The level a step lives on: its siblings and their connections. */
export function levelOf(
  graph: GraphLevel,
  nodeId: string,
): GraphLevel | undefined {
  const scope = scopeOf(graph, nodeId);
  return scope === undefined ? undefined : levelAt(graph, scope);
}

/**
 * A step with its surroundings: the level it's on and, inside a For each
 * body, that body's inputs (`item`, `ordinal`) it can read.
 */
export function locateStep(
  graph: GraphLevel,
  nodeId: string,
):
  | Readonly<{
      node: WorkflowNode;
      level: GraphLevel;
      loopPorts: readonly string[];
    }>
  | undefined {
  const at = indexGraph(graph).nodes.get(nodeId);
  const level = at === undefined ? undefined : levelAt(graph, at.scope);
  if (at === undefined || level === undefined) return undefined;
  const loopId = loopOf(at.scope);
  const body =
    loopId === undefined ? undefined : findStep(graph, loopId)?.structured;
  return { node: at.item, level, loopPorts: body?.body.inputPorts ?? [] };
}

/** The For each whose body a scope names, or undefined for the workflow. */
export function loopOf(scope: ScopePath): string | undefined {
  return scope.at(-1);
}

export function sameScope(left: ScopePath, right: ScopePath): boolean {
  return (
    left.length === right.length &&
    left.every((loopId, index) => right[index] === loopId)
  );
}

/** Two steps can be connected: both exist, differ and share a level. */
export function canConnectSteps(
  graph: GraphLevel,
  sourceId: string,
  targetId: string,
): boolean {
  const source = scopeOf(graph, sourceId);
  const target = scopeOf(graph, targetId);
  return (
    sourceId !== targetId &&
    source !== undefined &&
    target !== undefined &&
    sameScope(source, target)
  );
}

/**
 * Applies `change` to the level at `scope` and writes it back through the
 * For each steps above it. Returns `graph` itself when nothing changed or
 * the scope no longer exists. `prepareBody` runs on each body on the way
 * down before it changes; it's kept only if the change goes through.
 */
export function mapLevel<Level extends GraphLevel>(
  graph: Level,
  scope: ScopePath,
  change: LevelChange,
  prepareBody: LevelChange = (level) => level,
): Level {
  const [loopId, ...rest] = scope;
  if (loopId === undefined) return change(graph);
  const nodes = graph.nodes.map((node) => {
    if (node.id !== loopId || node.structured === undefined) return node;
    const prepared = prepareBody(node.structured.body);
    const next = mapLevel(prepared, rest, change, prepareBody);
    return next === prepared
      ? node
      : { ...node, structured: { ...node.structured, body: next } };
  });
  return nodes.some((node, index) => node !== graph.nodes[index])
    ? { ...graph, nodes }
    : graph;
}

/** Groups IDs by the scope each lives in, keeping their order. */
export function groupByScope(
  ids: readonly string[],
  scopeFor: (id: string) => ScopePath | undefined,
): readonly Readonly<{ scope: ScopePath; ids: readonly string[] }>[] {
  const groups = new Map<string, { scope: ScopePath; ids: string[] }>();
  for (const id of ids) {
    const scope = scopeFor(id);
    if (scope === undefined) continue;
    const key = JSON.stringify(scope);
    const group = groups.get(key) ?? { scope, ids: [] };
    group.ids.push(id);
    groups.set(key, group);
  }
  return [...groups.values()];
}
