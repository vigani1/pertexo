import type { WorkflowGraphContract } from '@pertexo/contracts';
import { settleBodyLayout } from './for-each-body-layout';
import {
  groupByScope,
  indexGraph,
  type GraphLevel,
  type ScopePath,
  type WorkflowEdge,
  type WorkflowNode,
} from './scopes';
import { changeLevel } from './levels';

export type RemovedElements = Readonly<{
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  /** The level each removed step or link was on, by ID. */
  scopes: Readonly<Record<string, ScopePath>>;
}>;

export function removeWorkflowNode(
  graph: WorkflowGraphContract,
  nodeId: string,
): WorkflowGraphContract {
  return removeWorkflowElements(graph, { nodeIds: [nodeId], edgeIds: [] })
    .graph;
}

interface RemovalCollector {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  scopes: Record<string, ScopePath>;
}

type Removal = Readonly<{
  nodeIds: ReadonlySet<string>;
  edgeIds: ReadonlySet<string>;
  removed: RemovalCollector;
}>;

/**
 * Removes steps (with their links and, for a For each, its body) and
 * links as one change, wherever they are.
 */
export function removeWorkflowElements(
  graph: WorkflowGraphContract,
  selection: Readonly<{
    nodeIds: readonly string[];
    edgeIds: readonly string[];
  }>,
): Readonly<{ graph: WorkflowGraphContract; removed: RemovedElements }> {
  const removal: Removal = {
    nodeIds: new Set(selection.nodeIds),
    edgeIds: new Set(selection.edgeIds),
    removed: { nodes: [], edges: [], scopes: {} },
  };
  return { graph: removeIn(graph, [], removal), removed: removal.removed };
}

function removeIn<Level extends GraphLevel>(
  level: Level,
  scope: ScopePath,
  removal: Removal,
): Level {
  const { nodeIds, edgeIds, removed } = removal;
  let nodesChanged = false;
  const nodes: WorkflowNode[] = [];
  for (const node of level.nodes) {
    if (nodeIds.has(node.id)) {
      removed.nodes.push(node);
      removed.scopes[node.id] = scope;
      nodesChanged = true;
      continue;
    }
    const kept = removeInLoop(node, [...scope, node.id], removal);
    nodesChanged ||= kept !== node;
    nodes.push(kept);
  }
  const edges = level.edges.filter((edge) => {
    const gone =
      edgeIds.has(edge.id) ||
      nodeIds.has(edge.source.nodeId) ||
      nodeIds.has(edge.target.nodeId);
    if (gone) {
      removed.edges.push(edge);
      removed.scopes[edge.id] = scope;
    }
    return !gone;
  });
  const edgesChanged = edges.length !== level.edges.length;
  if (!nodesChanged && !edgesChanged) return level;
  return {
    ...level,
    nodes: nodesChanged ? nodes : level.nodes,
    edges: edgesChanged ? edges : level.edges,
  };
}

/** A kept For each without whatever was removed from its body. */
function removeInLoop(
  node: WorkflowNode,
  scope: ScopePath,
  removal: Removal,
): WorkflowNode {
  const structured = node.structured;
  if (structured === undefined) return node;
  const settled = settleBodyLayout(structured.body);
  const body = removeIn(settled, scope, removal);
  return body === settled
    ? node
    : { ...node, structured: { ...structured, body } };
}

/**
 * Puts removed steps and links back on their levels. Used by an Undo
 * toast after other edits happened, so it only restores what still fits the
 * current graph: a level that's gone takes its steps with it.
 */
export function restoreWorkflowElements(
  graph: WorkflowGraphContract,
  removed: RemovedElements,
): WorkflowGraphContract {
  const scopeFor = (id: string) => removed.scopes[id] ?? [];
  const present = indexGraph(graph);
  const nodes = removed.nodes.filter((node) => !present.nodes.has(node.id));
  let next = graph;
  for (const { scope, ids } of groupByScope(
    nodes.map((node) => node.id),
    scopeFor,
  )) {
    const adding = nodes.filter((node) => ids.includes(node.id));
    next = changeLevel(next, scope, (level) => ({
      ...level,
      nodes: [...level.nodes, ...adding],
    }));
  }
  const restored = indexGraph(next);
  const edges = removed.edges.filter(
    (edge) =>
      !restored.edges.has(edge.id) &&
      restored.nodes.has(edge.source.nodeId) &&
      restored.nodes.has(edge.target.nodeId),
  );
  for (const { scope, ids } of groupByScope(
    edges.map((edge) => edge.id),
    scopeFor,
  )) {
    const adding = edges.filter((edge) => ids.includes(edge.id));
    next = changeLevel(next, scope, (level) => ({
      ...level,
      edges: [...level.edges, ...adding],
    }));
  }
  return next;
}
