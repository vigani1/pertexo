import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import type { Connection } from '@xyflow/react';
import {
  cardSize,
  makeRoomAround,
  overlaps,
  settleBodyLayout,
  STEP_CARD,
} from './body-layout';
import {
  canConnectSteps,
  emptyLoopStructure,
  findStep,
  groupByScope,
  indexGraph,
  isForEach,
  levelAt,
  mapLevel,
  sameScope,
  scopeOf,
  type GraphLevel,
  type LevelChange,
  type ScopePath,
  type WorkflowEdge,
  type WorkflowNode,
} from './graph-scopes';

// Pure graph transitions. Each returns the same graph object when nothing
// changes, so a no-op never becomes an undo step or a save. Steps and
// connections are found wherever they live, inside For each bodies too, and
// every change stays on the level it belongs to.

type Position = Readonly<{ x: number; y: number }>;

export type RemovedElements = Readonly<{
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  /** The level each removed step or connection was on, by ID. */
  scopes: Readonly<Record<string, ScopePath>>;
}>;

/** One end of a connection: a step and one of its ports. */
export type PortRef = Readonly<{ nodeId: string; port: string }>;

type NewIds = Readonly<{ nodeId: string; edgeId: string }>;

/** Changes one level; a body is first stored in the layout it's shown in. */
function changeLevel<Graph extends GraphLevel>(
  graph: Graph,
  scope: ScopePath,
  change: LevelChange,
): Graph {
  return mapLevel(graph, scope, change, settleBodyLayout);
}

/** A new step of a catalog type. A For each starts with an empty body. */
function newStep(
  definition: NodeDefinitionCatalogItem,
  position: Position,
  id: string,
): WorkflowNode {
  const node = {
    id,
    definition: definition.definition,
    position,
    configVersion: definition.configVersion,
    config: {},
    inputMappings: {},
    connectionRefs: {},
  } satisfies WorkflowNode;
  return isForEach(node) ? { ...node, structured: emptyLoopStructure() } : node;
}

export function addDefinitionNode(
  graph: WorkflowGraphContract,
  definition: NodeDefinitionCatalogItem,
  position: Position,
  id: string = crypto.randomUUID(),
): WorkflowGraphContract {
  return {
    ...graph,
    nodes: [...graph.nodes, newStep(definition, position, id)],
  };
}

/**
 * Adds a step and connects it from `from` as one change, so a single undo
 * takes both back. The step joins `from` on its level (inside the same
 * body, if it's in one). It uses the input named like the source port when
 * it has one (a Merge pairs `branch-03` with `branch-03`), otherwise its
 * first input. Returns null when that isn't possible.
 */
export function addStepAfter(
  graph: WorkflowGraphContract,
  definition: NodeDefinitionCatalogItem,
  position: Position,
  from: PortRef,
  ids: NewIds = { nodeId: crypto.randomUUID(), edgeId: crypto.randomUUID() },
): WorkflowGraphContract | null {
  const inputs = definition.ports.inputs;
  const targetPort = inputs.includes(from.port) ? from.port : inputs[0];
  const scope = scopeOf(graph, from.nodeId);
  if (targetPort === undefined || scope === undefined) return null;
  const node = newStep(definition, position, ids.nodeId);
  const edge = {
    id: ids.edgeId,
    source: { nodeId: from.nodeId, port: from.port },
    target: { nodeId: ids.nodeId, port: targetPort },
  } satisfies WorkflowEdge;
  return changeLevel(graph, scope, (level) => ({
    ...level,
    nodes: [...level.nodes, node],
    edges: [...level.edges, edge],
  }));
}

/**
 * Adds a step inside a For each's body, connected from `from` when given
 * (a step already in that body). A For each without a body gets one.
 */
export function addBodyStep(
  graph: WorkflowGraphContract,
  loopId: string,
  definition: NodeDefinitionCatalogItem,
  position: Position,
  ids: NewIds = { nodeId: crypto.randomUUID(), edgeId: crypto.randomUUID() },
  from?: PortRef,
): WorkflowGraphContract | null {
  const loop = findStep(graph, loopId);
  const loopScope = scopeOf(graph, loopId);
  if (loop === undefined || loopScope === undefined || !isForEach(loop))
    return null;
  const withBody =
    loop.structured === undefined
      ? changeLevel(graph, loopScope, (level) => ({
          ...level,
          nodes: level.nodes.map((node) =>
            node.id === loopId
              ? { ...node, structured: emptyLoopStructure() }
              : node,
          ),
        }))
      : graph;
  const bodyScope = [...loopScope, loopId];
  let added: WorkflowGraphContract | null;
  if (from !== undefined) {
    const fromScope = scopeOf(withBody, from.nodeId);
    added =
      fromScope !== undefined && sameScope(fromScope, bodyScope)
        ? addStepAfter(withBody, definition, position, from, ids)
        : null;
  } else {
    const node = newStep(definition, position, ids.nodeId);
    added = changeLevel(withBody, bodyScope, (level) => ({
      ...level,
      nodes: [...level.nodes, node],
    }));
  }
  // The container grew around its new step: move what it would now cover.
  return added === null
    ? null
    : changeLevel(added, loopScope, (level) =>
        makeRoomAround(level, loopId, loop),
      );
}

export function moveWorkflowNode(
  graph: WorkflowGraphContract,
  nodeId: string,
  position: Position,
): WorkflowGraphContract {
  return moveWorkflowNodes(graph, new Map([[nodeId, position]]));
}

/** Moves steps to positions on their own level (body steps: body coordinates). */
export function moveWorkflowNodes(
  graph: WorkflowGraphContract,
  positions: ReadonlyMap<string, Position>,
): WorkflowGraphContract {
  let next = graph;
  for (const { scope } of groupByScope([...positions.keys()], (id) =>
    scopeOf(graph, id),
  ))
    next = changeLevel(next, scope, (level) => moveIn(level, positions));
  return next;
}

function moveIn<Level extends GraphLevel>(
  level: Level,
  positions: ReadonlyMap<string, Position>,
): Level {
  const nodes = level.nodes.map((node) => {
    const position = positions.get(node.id);
    if (
      position === undefined ||
      (node.position.x === position.x && node.position.y === position.y)
    )
      return node;
    return { ...node, position: { x: position.x, y: position.y } };
  });
  return nodes.some((node, index) => node !== level.nodes[index])
    ? { ...level, nodes }
    : level;
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
  const scope = scopeOf(graph, nodeId);
  if (scope === undefined) return graph;
  return changeLevel(graph, scope, (level) => updateIn(level, nodeId, update));
}

function updateIn<Level extends GraphLevel>(
  level: Level,
  nodeId: string,
  update: WorkflowNodeUpdate,
): Level {
  const target = level.nodes.find((node) => node.id === nodeId);
  if (target === undefined || !changesNode(target, update)) return level;
  return {
    ...level,
    nodes: level.nodes.map((node) => {
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
 * Removes steps (with their connections and, for a For each, its body) and
 * connections as one change, wherever they are.
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
 * Puts removed steps and connections back on their levels. Used by an Undo
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

/**
 * Connects two steps on the same level. Returns null for anything the
 * workflow can't hold: a missing port, a step connected to itself, a
 * connection across a For each body's edge, or one that already exists.
 */
export function connectWorkflowNodes(
  graph: WorkflowGraphContract,
  connection: Connection,
  id: string = crypto.randomUUID(),
): WorkflowGraphContract | null {
  const { source, sourceHandle, target, targetHandle } = connection;
  if (sourceHandle === null || targetHandle === null) return null;
  const scope = scopeOf(graph, source);
  if (scope === undefined || !canConnectSteps(graph, source, target))
    return null;
  const duplicate = levelAt(graph, scope)?.edges.some(
    (edge) =>
      edge.source.nodeId === source &&
      edge.source.port === sourceHandle &&
      edge.target.nodeId === target &&
      edge.target.port === targetHandle,
  );
  if (duplicate !== false) return null;
  const edge = {
    id,
    source: { nodeId: source, port: sourceHandle },
    target: { nodeId: target, port: targetHandle },
  } satisfies WorkflowEdge;
  return changeLevel(graph, scope, (level) => ({
    ...level,
    edges: [...level.edges, edge],
  }));
}

/** One card width and a gap to the right of `node`, on the same row. */
export function positionAfter(
  node: Pick<WorkflowNode, 'position'>,
  width: number = STEP_CARD.width,
): Position {
  return { x: node.position.x + width + 64, y: node.position.y };
}

/** Space kept between a new step and the cards around it. */
const GUTTER = 24;

/**
 * Where a new step can go at `desired` without covering another step: the
 * same column, moved down below whatever card is in the way (a second
 * branch's step lands under the first). Cards are measured as drawn, a
 * For each with its whole body.
 */
export function freePosition(level: GraphLevel, desired: Position): Position {
  const size = { width: STEP_CARD.width + GUTTER, height: 80 + GUTTER };
  let candidate = { x: Math.round(desired.x), y: Math.round(desired.y) };
  for (let attempt = 0; attempt < level.nodes.length + 1; attempt += 1) {
    const blocker = level.nodes.find((node) =>
      overlaps(
        { ...candidate, ...size },
        { ...node.position, ...cardSize(node) },
      ),
    );
    if (blocker === undefined) return candidate;
    candidate = {
      x: candidate.x,
      y: Math.round(blocker.position.y + cardSize(blocker).height + GUTTER),
    };
  }
  return candidate;
}
