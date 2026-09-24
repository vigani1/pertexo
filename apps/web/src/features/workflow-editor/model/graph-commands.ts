import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import type { Connection } from '@xyflow/react';

// Pure graph transitions. Each returns the same graph object when nothing
// changes, so a no-op never becomes an undo step or a save.

type WorkflowNode = WorkflowGraphContract['nodes'][number];
type WorkflowEdge = WorkflowGraphContract['edges'][number];
type Position = Readonly<{ x: number; y: number }>;

export type RemovedElements = Readonly<{
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}>;

export function addDefinitionNode(
  graph: WorkflowGraphContract,
  definition: NodeDefinitionCatalogItem,
  position: Position,
  id: string = crypto.randomUUID(),
): WorkflowGraphContract {
  const node = {
    id,
    definition: definition.definition,
    position,
    configVersion: definition.configVersion,
    config: {},
    inputMappings: {},
    connectionRefs: {},
  } satisfies WorkflowNode;
  return { ...graph, nodes: [...graph.nodes, node] };
}

export function moveWorkflowNode(
  graph: WorkflowGraphContract,
  nodeId: string,
  position: Position,
): WorkflowGraphContract {
  return moveWorkflowNodes(graph, new Map([[nodeId, position]]));
}

export function moveWorkflowNodes(
  graph: WorkflowGraphContract,
  positions: ReadonlyMap<string, Position>,
): WorkflowGraphContract {
  const nodes = graph.nodes.map((node) => {
    const position = positions.get(node.id);
    if (
      position === undefined ||
      (node.position.x === position.x && node.position.y === position.y)
    )
      return node;
    return { ...node, position: { x: position.x, y: position.y } };
  });
  return nodes.some((node, index) => node !== graph.nodes[index])
    ? { ...graph, nodes }
    : graph;
}

export type WorkflowNodeUpdate = Readonly<{
  label?: string | undefined;
  config?: WorkflowNode['config'];
  inputMappings?: WorkflowNode['inputMappings'];
  connectionRefs?: WorkflowNode['connectionRefs'];
  disabled?: boolean;
}>;

export function updateWorkflowNode(
  graph: WorkflowGraphContract,
  nodeId: string,
  update: WorkflowNodeUpdate,
): WorkflowGraphContract {
  const target = graph.nodes.find((node) => node.id === nodeId);
  if (target === undefined || !changesNode(target, update)) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      const updated = { ...node, ...update };
      if (updated.label === undefined) delete updated.label;
      if (updated.disabled !== true) delete updated.disabled;
      return updated;
    }),
  };
}

function changesNode(node: WorkflowNode, update: WorkflowNodeUpdate): boolean {
  return (Object.keys(update) as (keyof WorkflowNodeUpdate)[]).some((key) => {
    if (key === 'disabled')
      return (node.disabled ?? false) !== (update.disabled ?? false);
    return JSON.stringify(node[key]) !== JSON.stringify(update[key]);
  });
}

export function removeWorkflowNode(
  graph: WorkflowGraphContract,
  nodeId: string,
): WorkflowGraphContract {
  return removeWorkflowElements(graph, { nodeIds: [nodeId], edgeIds: [] })
    .graph;
}

/** Removes steps (with their connections) and connections as one change. */
export function removeWorkflowElements(
  graph: WorkflowGraphContract,
  selection: Readonly<{
    nodeIds: readonly string[];
    edgeIds: readonly string[];
  }>,
): Readonly<{ graph: WorkflowGraphContract; removed: RemovedElements }> {
  const nodeIds = new Set(selection.nodeIds);
  const edgeIds = new Set(selection.edgeIds);
  const removedNodes = graph.nodes.filter((node) => nodeIds.has(node.id));
  const removedEdges = graph.edges.filter(
    (edge) =>
      edgeIds.has(edge.id) ||
      nodeIds.has(edge.source.nodeId) ||
      nodeIds.has(edge.target.nodeId),
  );
  if (removedNodes.length === 0 && removedEdges.length === 0)
    return { graph, removed: { nodes: [], edges: [] } };
  const removedEdgeIds = new Set(removedEdges.map((edge) => edge.id));
  return {
    graph: {
      ...graph,
      nodes:
        removedNodes.length === 0
          ? graph.nodes
          : graph.nodes.filter((node) => !nodeIds.has(node.id)),
      edges: graph.edges.filter((edge) => !removedEdgeIds.has(edge.id)),
    },
    removed: { nodes: removedNodes, edges: removedEdges },
  };
}

/**
 * Puts removed steps and connections back. Used by an Undo toast after other
 * edits happened, so it only restores what still fits the current graph.
 */
export function restoreWorkflowElements(
  graph: WorkflowGraphContract,
  removed: RemovedElements,
): WorkflowGraphContract {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const nodes = removed.nodes.filter((node) => !nodeIds.has(node.id));
  const allNodeIds = new Set([...nodeIds, ...nodes.map((node) => node.id)]);
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  const edges = removed.edges.filter(
    (edge) =>
      !edgeIds.has(edge.id) &&
      allNodeIds.has(edge.source.nodeId) &&
      allNodeIds.has(edge.target.nodeId),
  );
  if (nodes.length === 0 && edges.length === 0) return graph;
  return {
    ...graph,
    nodes: [...graph.nodes, ...nodes],
    edges: [...graph.edges, ...edges],
  };
}

export function connectWorkflowNodes(
  graph: WorkflowGraphContract,
  connection: Connection,
  id: string = crypto.randomUUID(),
): WorkflowGraphContract | null {
  if (connection.sourceHandle === null || connection.targetHandle === null)
    return null;
  if (connection.source === connection.target) return null;
  const duplicate = graph.edges.some(
    (edge) =>
      edge.source.nodeId === connection.source &&
      edge.source.port === connection.sourceHandle &&
      edge.target.nodeId === connection.target &&
      edge.target.port === connection.targetHandle,
  );
  if (duplicate) return null;
  const edge = {
    id,
    source: { nodeId: connection.source, port: connection.sourceHandle },
    target: { nodeId: connection.target, port: connection.targetHandle },
  } satisfies WorkflowEdge;
  return { ...graph, edges: [...graph.edges, edge] };
}

/**
 * Copies steps with fresh IDs, offset from the originals. Connections between
 * copied steps are copied too, and mappings that read a copied step follow it.
 */
export function duplicateWorkflowNodes(
  graph: WorkflowGraphContract,
  nodeIds: readonly string[],
  createId: () => string = () => crypto.randomUUID(),
  offset: Position = { x: 48, y: 48 },
): Readonly<{ graph: WorkflowGraphContract; nodeIds: readonly string[] }> {
  const sources = graph.nodes.filter((node) => nodeIds.includes(node.id));
  if (sources.length === 0) return { graph, nodeIds: [] };
  const idMap = new Map(sources.map((node) => [node.id, createId()]));
  const copies = sources.map((node) => ({
    ...node,
    id: idMap.get(node.id) ?? createId(),
    position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
    inputMappings: Object.fromEntries(
      Object.entries(node.inputMappings).map(([key, source]) => [
        key,
        source.kind === 'node_output' && idMap.has(source.nodeId)
          ? { ...source, nodeId: idMap.get(source.nodeId) ?? source.nodeId }
          : source,
      ]),
    ),
  }));
  const edges = graph.edges.flatMap((edge) => {
    const source = idMap.get(edge.source.nodeId);
    const target = idMap.get(edge.target.nodeId);
    if (source === undefined || target === undefined) return [];
    return [
      {
        id: createId(),
        source: { nodeId: source, port: edge.source.port },
        target: { nodeId: target, port: edge.target.port },
      },
    ];
  });
  return {
    graph: {
      ...graph,
      nodes: [...graph.nodes, ...copies],
      edges: [...graph.edges, ...edges],
    },
    nodeIds: copies.map((node) => node.id),
  };
}

const CARD_CLEARANCE = 40;
const NUDGE = 32;

/** The nearest spot at or below-right of `desired` that no step occupies. */
export function freePosition(
  graph: WorkflowGraphContract,
  desired: Position,
): Position {
  let candidate = { x: Math.round(desired.x), y: Math.round(desired.y) };
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const taken = graph.nodes.some(
      (node) =>
        Math.abs(node.position.x - candidate.x) < CARD_CLEARANCE &&
        Math.abs(node.position.y - candidate.y) < CARD_CLEARANCE,
    );
    if (!taken) return candidate;
    candidate = { x: candidate.x + NUDGE, y: candidate.y + NUDGE };
  }
  return candidate;
}

/**
 * Makes one step match another version of the graph: copies it (with its
 * connections to steps that exist here) or removes it if that version has
 * none. This is how a kept copy's edits are re-applied after a conflict.
 */
export function adoptStepFrom(
  graph: WorkflowGraphContract,
  source: WorkflowGraphContract,
  nodeId: string,
): WorkflowGraphContract {
  const node = source.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined)
    return removeWorkflowElements(graph, { nodeIds: [nodeId], edgeIds: [] })
      .graph;
  const exists = graph.nodes.some((candidate) => candidate.id === nodeId);
  const nodes = exists
    ? graph.nodes.map((candidate) =>
        candidate.id === nodeId ? node : candidate,
      )
    : [...graph.nodes, node];
  const nodeIds = new Set(nodes.map((candidate) => candidate.id));
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  const edges = source.edges.filter(
    (edge) =>
      (edge.source.nodeId === nodeId || edge.target.nodeId === nodeId) &&
      !edgeIds.has(edge.id) &&
      nodeIds.has(edge.source.nodeId) &&
      nodeIds.has(edge.target.nodeId),
  );
  return { ...graph, nodes, edges: [...graph.edges, ...edges] };
}
