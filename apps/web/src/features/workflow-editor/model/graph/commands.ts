import { inspectWorkflowFailureRoutes } from '@pertexo/workflow-model';
import type {
  NodeDefinitionCatalogItem,
  WorkflowGraphContract,
} from '@pertexo/contracts';
import type { Connection } from '@xyflow/react';
import { startingConfig } from './starting-config';
import {
  cardSize,
  makeRoomAround,
  overlaps,
  STEP_CARD,
} from './for-each-body-layout';
import {
  canLinkSteps,
  emptyLoopStructure,
  findStep,
  groupByScope,
  isForEach,
  levelAt,
  sameScope,
  scopeOf,
  type GraphLevel,
  type WorkflowEdge,
  type WorkflowNode,
} from './scopes';
import { changeLevel } from './levels';

// Pure graph transitions. Each returns the same graph object when nothing
// changes, so a no-op never becomes an undo step or a save. Steps and
// links are found wherever they live, inside For each bodies too, and
// every change stays on the level it belongs to.

type Position = Readonly<{ x: number; y: number }>;

/** One end of a link: a step and one of its ports. */
export type PortRef = Readonly<{ nodeId: string; port: string }>;

type NewIds = Readonly<{ nodeId: string; edgeId: string }>;

/** A new step of a catalog type. A For each starts with an empty body. */
function newStep(
  definition: NodeDefinitionCatalogItem,
  position: Position,
  id: string,
  levelNodes: readonly WorkflowNode[],
): WorkflowNode {
  const node = {
    id,
    definition: definition.definition,
    position,
    configVersion: definition.configVersion,
    config: startingConfig(definition.definition.key, levelNodes),
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
    nodes: [...graph.nodes, newStep(definition, position, id, graph.nodes)],
  };
}

/**
 * Adds a step and links it from `from` as one change, so a single undo
 * takes both back. The step joins `from` on its level (inside the same
 * body, if it's in one). It uses the input named like the source port when
 * it has one (a Merge pairs `branch-03` with `branch-03`), otherwise its
 * first input. Returns null when that isn't possible.
 */
export function addStepAfter({
  graph,
  definition,
  position,
  from,
  ids = { nodeId: crypto.randomUUID(), edgeId: crypto.randomUUID() },
}: Readonly<{
  graph: WorkflowGraphContract;
  definition: NodeDefinitionCatalogItem;
  position: Position;
  from: PortRef;
  ids?: NewIds | undefined;
}>): WorkflowGraphContract | null {
  const inputs = definition.ports.inputs;
  const targetPort = inputs.includes(from.port) ? from.port : inputs[0];
  const scope = scopeOf(graph, from.nodeId);
  if (targetPort === undefined || scope === undefined) return null;
  const edge = {
    id: ids.edgeId,
    source: { nodeId: from.nodeId, port: from.port },
    target: { nodeId: ids.nodeId, port: targetPort },
  } satisfies WorkflowEdge;
  return changeLevel(graph, scope, (level) => ({
    ...level,
    nodes: [
      ...level.nodes,
      newStep(definition, position, ids.nodeId, level.nodes),
    ],
    edges: [...level.edges, edge],
  }));
}

/**
 * Adds a step inside a For each's body, linked from `from` when given
 * (a step already in that body). A For each without a body gets one.
 */
export function addBodyStep({
  graph,
  loopId,
  definition,
  position,
  ids = { nodeId: crypto.randomUUID(), edgeId: crypto.randomUUID() },
  from,
}: Readonly<{
  graph: WorkflowGraphContract;
  loopId: string;
  definition: NodeDefinitionCatalogItem;
  position: Position;
  ids?: NewIds | undefined;
  from?: PortRef | undefined;
}>): WorkflowGraphContract | null {
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
        ? addStepAfter({ graph: withBody, definition, position, from, ids })
        : null;
  } else {
    added = changeLevel(withBody, bodyScope, (level) => ({
      ...level,
      nodes: [
        ...level.nodes,
        newStep(definition, position, ids.nodeId, level.nodes),
      ],
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
  retry?: WorkflowNode['retry'];
  structured?: WorkflowNode['structured'];
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
      if (!(updated.disabled ?? false)) delete updated.disabled;
      if (updated.retry === undefined) delete updated.retry;
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

/**
 * Links two steps on the same level. Returns null for anything the
 * workflow can't hold: a missing port, a step linked to itself, a
 * link across a For each body's edge, or one that already exists.
 */
export function linkWorkflowNodes(
  graph: WorkflowGraphContract,
  link: Connection,
  id: string = crypto.randomUUID(),
): WorkflowGraphContract | null {
  const { source, sourceHandle, target, targetHandle } = link;
  if (sourceHandle === null || targetHandle === null) return null;
  const scope = scopeOf(graph, source);
  if (scope === undefined || !canLinkSteps(graph, source, target)) return null;
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
  const next = changeLevel(graph, scope, (level) => ({
    ...level,
    edges: [...level.edges, edge],
  }));
  return inspectWorkflowFailureRoutes(next).kind === 'invalid' ? null : next;
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
