/**
 * Checks aggregate graph resources without invoking accessors or relying on
 * the structural parser. This is shared by the browser contract and the
 * server parser after their respective hostile-input guards.
 */
export function hasBoundedGraphAggregateUnsafe(
  input: unknown,
  limits: Readonly<{
    readonly nodes: number;
    readonly edges: number;
    readonly structuredDepth: number;
  }>,
): boolean {
  const pending: readonly [unknown, number][] = [[input, 0]];
  const graphs = [...pending];
  let nodes = 0;
  let edges = 0;
  while (graphs.length > 0) {
    const entry = graphs.pop();
    if (entry === undefined) continue;
    const [value, depth] = entry;
    if (depth > limits.structuredDepth) return false;
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      continue;
    const nodeDescriptor = Object.getOwnPropertyDescriptor(value, 'nodes');
    const edgeDescriptor = Object.getOwnPropertyDescriptor(value, 'edges');
    if (!nodeDescriptor || !('value' in nodeDescriptor)) continue;
    if (!edgeDescriptor || !('value' in edgeDescriptor)) continue;
    const graphNodes = nodeDescriptor.value as unknown;
    const graphEdges = edgeDescriptor.value as unknown;
    if (!Array.isArray(graphNodes) || !Array.isArray(graphEdges)) continue;
    nodes += graphNodes.length;
    edges += graphEdges.length;
    if (nodes > limits.nodes || edges > limits.edges) return false;
    for (let index = graphNodes.length - 1; index >= 0; index -= 1) {
      const nodeDescriptor = Object.getOwnPropertyDescriptor(
        graphNodes,
        String(index),
      );
      if (!nodeDescriptor || !('value' in nodeDescriptor)) continue;
      const node = nodeDescriptor.value as unknown;
      if (node === null || typeof node !== 'object' || Array.isArray(node))
        continue;
      const structuredDescriptor = Object.getOwnPropertyDescriptor(
        node,
        'structured',
      );
      if (!structuredDescriptor || !('value' in structuredDescriptor)) continue;
      const structured = structuredDescriptor.value as unknown;
      if (
        structured === null ||
        typeof structured !== 'object' ||
        Array.isArray(structured)
      )
        continue;
      const bodyDescriptor = Object.getOwnPropertyDescriptor(
        structured,
        'body',
      );
      if (bodyDescriptor && 'value' in bodyDescriptor)
        graphs.push([bodyDescriptor.value, depth + 1]);
    }
  }
  return true;
}
