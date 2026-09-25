import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { cardSize, overlaps, settleBodyLayout } from './body-layout';
import { removeWorkflowElements } from './graph-commands';
import {
  groupByScope,
  mapLevel,
  scopeOf,
  type GraphLevel,
  type WorkflowEdge,
  type WorkflowNode,
} from './graph-scopes';

// Copies of steps: duplicates made on the canvas, and a step taken over
// from another version of the workflow after a conflict.

type Position = Readonly<{ x: number; y: number }>;
type CreateId = () => string;

/**
 * Copies steps with fresh IDs, each on its own level, placed just below the
 * copied steps and clear of any other step (or `offset` from the originals
 * when given). Connections between copied steps are copied too, and mappings that
 * read a copied step follow it. A copied For each gets a copy of its body,
 * with fresh IDs throughout, since IDs are unique across the workflow.
 */
export function duplicateWorkflowNodes(
  graph: WorkflowGraphContract,
  nodeIds: readonly string[],
  createId: CreateId = () => crypto.randomUUID(),
  offset?: Position,
): Readonly<{ graph: WorkflowGraphContract; nodeIds: readonly string[] }> {
  let next = graph;
  const copied: string[] = [];
  for (const group of groupByScope(nodeIds, (id) => scopeOf(graph, id)))
    next = mapLevel(
      next,
      group.scope,
      (level) => {
        const result = copySteps(level, group.ids, createId, offset);
        copied.push(...result.nodeIds);
        return result.level;
      },
      settleBodyLayout,
    );
  return { graph: next, nodeIds: copied };
}

function copySteps<Level extends GraphLevel>(
  level: Level,
  nodeIds: readonly string[],
  createId: CreateId,
  offset: Position | undefined,
): Readonly<{ level: Level; nodeIds: readonly string[] }> {
  const wanted = new Set(nodeIds);
  const sources = level.nodes.filter((node) => wanted.has(node.id));
  if (sources.length === 0) return { level, nodeIds: [] };
  const idMap = new Map(sources.map((node) => [node.id, createId()]));
  const shift = offset ?? clearOffset(level, sources);
  const copies = sources.map((node) => ({
    ...copyStep(node, idMap, createId),
    position: { x: node.position.x + shift.x, y: node.position.y + shift.y },
  }));
  return {
    level: {
      ...level,
      nodes: [...level.nodes, ...copies],
      edges: [...level.edges, ...copyEdges(level.edges, idMap, createId)],
    },
    nodeIds: copies.map((node) => node.id),
  };
}

const COPY_GAP = 24;

/**
 * How far down to move copies so none covers a step: at least the copied
 * group's own height, then further while any copy would sit on another.
 */
function clearOffset(
  level: GraphLevel,
  sources: readonly WorkflowNode[],
): Position {
  const top = Math.min(...sources.map((node) => node.position.y));
  const bottom = Math.max(
    ...sources.map((node) => node.position.y + cardSize(node).height),
  );
  let y = bottom - top + COPY_GAP;
  for (let attempt = 0; attempt <= level.nodes.length; attempt += 1) {
    const blocked = sources.some((source) => {
      const copy = {
        x: source.position.x,
        y: source.position.y + y,
        ...cardSize(source),
      };
      return level.nodes.some((node) =>
        overlaps(copy, { ...node.position, ...cardSize(node) }),
      );
    });
    if (!blocked) break;
    y += 80 + COPY_GAP;
  }
  return { x: 0, y: Math.round(y) };
}

/** A step under its new ID, reading copied steps instead of originals. */
function copyStep(
  node: WorkflowNode,
  idMap: ReadonlyMap<string, string>,
  createId: CreateId,
): WorkflowNode {
  const copy: WorkflowNode = {
    ...node,
    id: idMap.get(node.id) ?? createId(),
    inputMappings: Object.fromEntries(
      Object.entries(node.inputMappings).map(([key, source]) => [
        key,
        source.kind === 'node_output' && idMap.has(source.nodeId)
          ? { ...source, nodeId: idMap.get(source.nodeId) ?? source.nodeId }
          : source,
      ]),
    ),
  };
  const structured = node.structured;
  if (structured === undefined) return copy;
  const body = structured.body;
  const bodyIds = new Map(body.nodes.map((step) => [step.id, createId()]));
  return {
    ...copy,
    structured: {
      ...structured,
      body: {
        ...body,
        nodes: body.nodes.map((step) => copyStep(step, bodyIds, createId)),
        edges: copyEdges(body.edges, bodyIds, createId),
      },
    },
  };
}

/** Connections between copied steps, joining the copies. */
function copyEdges(
  edges: readonly WorkflowEdge[],
  idMap: ReadonlyMap<string, string>,
  createId: CreateId,
): readonly WorkflowEdge[] {
  return edges.flatMap((edge) => {
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
