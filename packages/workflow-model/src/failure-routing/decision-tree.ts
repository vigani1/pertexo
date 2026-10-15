import type { WorkflowEdge } from '../graph/contract.js';

export type DecisionTreeNode = Readonly<{
  id: string;
  definition: Readonly<{ key: string; version: number }>;
  disabled?: boolean | undefined;
  forEach?: unknown;
  structured?: unknown;
}>;

export type WorkflowDecisionTree = Readonly<{
  rootId: string;
  outgoing: ReadonlyMap<string, readonly WorkflowEdge[]>;
}>;

const excludedControls = new Set([
  'core.switch',
  'core.parallel',
  'core.merge',
  'core.foreach',
  'core.wait',
  'core.call',
]);

/** A single selected path can be frozen only without fan-out or convergence. */
export function inspectWorkflowDecisionTree(
  graph: Readonly<{
    nodes: readonly DecisionTreeNode[];
    edges: readonly WorkflowEdge[];
  }>,
): WorkflowDecisionTree | undefined {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  if (nodes.size === 0 || nodes.size !== graph.nodes.length) return undefined;
  for (const node of graph.nodes)
    if (
      excludedControls.has(node.definition.key) ||
      node.forEach !== undefined ||
      node.structured !== undefined ||
      (['core.condition', 'core.approval'].includes(node.definition.key) &&
        node.disabled === true) ||
      (['core.condition', 'core.approval', 'core.terminate'].includes(
        node.definition.key,
      ) &&
        node.definition.version !== 1)
    )
      return undefined;

  const incoming = new Set<string>();
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const edge of graph.edges) {
    const source = nodes.get(edge.source.nodeId);
    if (
      source === undefined ||
      !nodes.has(edge.target.nodeId) ||
      incoming.has(edge.target.nodeId) ||
      source.definition.key === 'core.terminate'
    )
      return undefined;
    incoming.add(edge.target.nodeId);
    const siblings = outgoing.get(source.id) ?? [];
    if (['core.condition', 'core.approval'].includes(source.definition.key)) {
      const ports =
        source.definition.key === 'core.approval'
          ? ['approved', 'rejected']
          : ['true', 'false'];
      if (
        !ports.includes(edge.source.port) ||
        siblings.some((sibling) => sibling.source.port === edge.source.port)
      )
        return undefined;
    } else if (siblings.length > 0) return undefined;
    siblings.push(edge);
    outgoing.set(source.id, siblings);
  }
  const roots = graph.nodes.filter((node) => !incoming.has(node.id));
  const root = roots[0];
  if (
    roots.length !== 1 ||
    root === undefined ||
    ![
      'core.workflow_error',
      'core.manual',
      'core.webhook',
      'core.schedule',
    ].includes(root.definition.key)
  )
    return undefined;

  const reached = new Set<string>();
  const pending = [root.id];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (nodeId === undefined) break;
    if (reached.has(nodeId)) return undefined;
    reached.add(nodeId);
    for (const edge of outgoing.get(nodeId) ?? [])
      pending.push(edge.target.nodeId);
  }
  if (reached.size !== nodes.size) return undefined;
  return { rootId: root.id, outgoing };
}
