import type { GraphLevel } from './graph-scopes';

/**
 * Execution depth of every step on one level: steps without incoming
 * connections are 0, every other step is one more than its deepest
 * predecessor. Cycles (which validation rejects anyway) are cut rather than
 * looping forever.
 */
export function stepDepths(graph: GraphLevel): ReadonlyMap<string, number> {
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const sources = incoming.get(edge.target.nodeId) ?? [];
    sources.push(edge.source.nodeId);
    incoming.set(edge.target.nodeId, sources);
  }
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  function depthOf(nodeId: string): number {
    const known = depths.get(nodeId);
    if (known !== undefined) return known;
    if (visiting.has(nodeId)) return 0;
    visiting.add(nodeId);
    const sources = incoming.get(nodeId) ?? [];
    const depth =
      sources.length === 0
        ? 0
        : Math.max(...sources.map((source) => depthOf(source) + 1));
    visiting.delete(nodeId);
    depths.set(nodeId, depth);
    return depth;
  }
  for (const node of graph.nodes) depthOf(node.id);
  return depths;
}

/** Each connection lights in the order its source step would run. */
export function edgeWeaveOrder(graph: GraphLevel): ReadonlyMap<string, number> {
  const depths = stepDepths(graph);
  return new Map(
    graph.edges.map((edge) => [edge.id, depths.get(edge.source.nodeId) ?? 0]),
  );
}

/** Connections on any path that leads into `nodeId`: a test's path. */
export function upstreamEdgeIds(
  graph: GraphLevel,
  nodeId: string,
): ReadonlySet<string> {
  const edgeIds = new Set<string>();
  const seen = new Set<string>([nodeId]);
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const edge of graph.edges) {
      if (edge.target.nodeId !== current) continue;
      edgeIds.add(edge.id);
      if (seen.has(edge.source.nodeId)) continue;
      seen.add(edge.source.nodeId);
      queue.push(edge.source.nodeId);
    }
  }
  return edgeIds;
}

/**
 * Steps on this level that nothing on it follows, in stored order. A For
 * each body must have exactly one: its output is each item's result.
 */
export function levelSinks(graph: GraphLevel): readonly string[] {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const leading = new Set(
    graph.edges.flatMap((edge) =>
      ids.has(edge.source.nodeId) && ids.has(edge.target.nodeId)
        ? [edge.source.nodeId]
        : [],
    ),
  );
  return graph.nodes.flatMap((node) => (leading.has(node.id) ? [] : [node.id]));
}
