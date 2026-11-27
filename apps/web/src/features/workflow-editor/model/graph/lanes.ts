import { stepDepths } from './order';
import type { GraphLevel, WorkflowEdge } from './scopes';

type Position = Readonly<{ x: number; y: number }>;

/** Distance between execution steps after tidying: a card and its link. */
export const LANE_COLUMN_WIDTH = 300;
/** Distance between lanes after tidying: a branching card and its result line. */
export const LANE_ROW_HEIGHT = 180;

/**
 * One lane: the steps a branch runs through. The lane a workflow starts in
 * has no `port`; a lane a branch opens names the port it leaves by.
 */
export type WorkflowLane = Readonly<{
  /** Top to bottom, as the lanes are drawn. */
  rank: number;
  /** The branch's port where a branch opened this lane. */
  opener: Readonly<{ nodeId: string; port: string }> | null;
  nodeIds: readonly string[];
}>;

/**
 * Splits one level into lanes. Each step continues the lane of the step
 * before it; where a step branches, the target placed closest to its own
 * height keeps the lane and every other branch opens a new one. Lanes are
 * ranked by where their steps sit now, so tidying keeps the picture the
 * author drew.
 */
export function workflowLanes(level: GraphLevel): readonly WorkflowLane[] {
  const positions = new Map(
    level.nodes.map((node) => [node.id, node.position]),
  );
  const outgoing = groupOutgoing(level.edges);
  const incoming = new Set(level.edges.map((edge) => edge.target.nodeId));
  const laneOf = new Map<string, number>();
  const lanes: { opener: WorkflowLane['opener']; nodeIds: string[] }[] = [];

  function follow(nodeId: string, lane: number) {
    if (laneOf.has(nodeId)) return;
    laneOf.set(nodeId, lane);
    lanes[lane]?.nodeIds.push(nodeId);
    const y = positions.get(nodeId)?.y ?? 0;
    const targets = (outgoing.get(nodeId) ?? [])
      .filter((edge) => !laneOf.has(edge.target.nodeId))
      .sort(
        (left, right) =>
          Math.abs((positions.get(left.target.nodeId)?.y ?? 0) - y) -
          Math.abs((positions.get(right.target.nodeId)?.y ?? 0) - y),
      );
    targets.forEach((edge, index) => {
      if (laneOf.has(edge.target.nodeId)) return;
      if (index === 0) {
        follow(edge.target.nodeId, lane);
        return;
      }
      lanes.push({ opener: edge.source, nodeIds: [] });
      follow(edge.target.nodeId, lanes.length - 1);
    });
  }

  const starts = level.nodes
    .filter((node) => !incoming.has(node.id))
    .sort(byPlace);
  // A cycle with no way in still gets a lane: start it at its first step.
  for (const node of [...starts, ...[...level.nodes].sort(byPlace)]) {
    if (laneOf.has(node.id)) continue;
    lanes.push({ opener: null, nodeIds: [] });
    follow(node.id, lanes.length - 1);
  }

  const height = (nodeIds: readonly string[]) =>
    nodeIds.reduce((sum, id) => sum + (positions.get(id)?.y ?? 0), 0) /
    Math.max(1, nodeIds.length);
  return lanes
    .map((lane) => ({ ...lane, height: height(lane.nodeIds) }))
    .sort((left, right) => left.height - right.height)
    .map(({ opener, nodeIds }, rank) => ({ rank, opener, nodeIds }));
}

/**
 * Where each step goes when the lanes are tidied: its execution depth sets
 * the column and its lane the row, from the workflow's current top-left
 * corner so the drawing doesn't jump away. Two steps that would share a
 * cell move the later one a column right.
 */
export function tidyLanePositions(
  level: GraphLevel,
): ReadonlyMap<string, Position> {
  if (level.nodes.length === 0) return new Map();
  const depths = stepDepths(level);
  const origin = {
    x: Math.min(...level.nodes.map((node) => node.position.x)),
    y: Math.min(...level.nodes.map((node) => node.position.y)),
  };
  const taken = new Set<string>();
  const positions = new Map<string, Position>();
  for (const lane of workflowLanes(level))
    for (const nodeId of lane.nodeIds) {
      let column = depths.get(nodeId) ?? 0;
      while (taken.has(`${String(lane.rank)}:${String(column)}`)) column += 1;
      taken.add(`${String(lane.rank)}:${String(column)}`);
      positions.set(nodeId, {
        x: origin.x + column * LANE_COLUMN_WIDTH,
        y: origin.y + lane.rank * LANE_ROW_HEIGHT,
      });
    }
  return positions;
}

function groupOutgoing(edges: readonly WorkflowEdge[]) {
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source.nodeId) ?? [];
    list.push(edge);
    outgoing.set(edge.source.nodeId, list);
  }
  return outgoing;
}

function byPlace(
  left: Readonly<{ position: Position }>,
  right: Readonly<{ position: Position }>,
) {
  return (
    left.position.y - right.position.y || left.position.x - right.position.x
  );
}
