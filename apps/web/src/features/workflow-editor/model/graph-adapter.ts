import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import type { CoordinateExtent, Edge, Node } from '@xyflow/react';
import { describeStep } from '@/features/catalog/presentation.public';
import {
  BODY_ORIGIN,
  bodyFrame,
  fromBodyPosition,
  toBodyPosition,
  type BodyFrame,
} from './body-layout';
import type { BodyIssue } from './body-rules';
import { portLinks, shownPorts, stepSummary } from './step-card';
import { levelSinks } from './graph-order';
import {
  indexGraph,
  isForEach,
  type GraphLevel,
  type WorkflowEdge,
  type WorkflowNode,
} from './graph-scopes';

type Position = Readonly<{ x: number; y: number }>;
type Size = Readonly<{ width: number; height: number }>;

/**
 * A For each step's body in summary (ADR 020): the steps that run once per
 * item, the body's `item`/`ordinal` inputs and `result` output, and the
 * bounds on items and concurrency. The graph itself is untouched.
 */
export type LoopSummary = Readonly<{
  maxIterations: number;
  maxConcurrency: number;
  /** The body's steps, in stored order. */
  steps: readonly Readonly<{ id: string; title: string }>[];
  inputs: readonly string[];
  outputs: readonly string[];
}>;

/** A For each container's body area on the canvas and what's wrong in it. */
type BodyArea = Readonly<{
  width: number;
  height: number;
  issues: readonly BodyIssue[];
}>;

interface WorkflowNodeData extends Record<string, unknown> {
  label: string | undefined;
  definitionKey: string;
  definitionVersion: number;
  family: NodeDefinitionCatalogItem['family'] | 'unknown';
  lifecycle: NodeDefinitionCatalogItem['lifecycle'] | undefined;
  /** The ports the card draws (branching steps: only the configured ones). */
  inputPorts: readonly string[];
  outputPorts: readonly string[];
  /** The step can have several inputs or outputs, so its ports are labelled. */
  branching: Readonly<{ inputs: boolean; outputs: boolean }>;
  /** Titles of the steps each port connects to, by port. */
  links: Readonly<{
    inputs: Readonly<Record<string, readonly string[]>>;
    outputs: Readonly<Record<string, readonly string[]>>;
  }>;
  /** A few words from the step's setup, e.g. "6 rules". */
  summary: string | undefined;
  /** Output size of this step's last passed test here, when it's known. */
  testOutputBytes: number | undefined;
  /** The latest check describes the draft on screen. */
  checked: boolean;
  issueCount: number;
  missingConnections: number;
  disabled: boolean;
  unsupported: boolean;
  /** The For each body, or null when the step has none yet. */
  loop: LoopSummary | null;
  /** A For each's body area; null for every other step. */
  body: BodyArea | null;
  /** This step ends its For each body: its output is each item's result. */
  bodyResult: boolean;
}

interface WorkflowEdgeData extends Record<string, unknown> {
  sourceLabel: string;
  targetLabel: string;
  /** The last successful test ran along this connection. */
  flowing: boolean;
  /** Execution depth for the publish weave-in; null when not weaving. */
  weaveOrder: number | null;
  /** The step this connection leads into has issues. */
  intoIssue: boolean;
}

/** `forEach` draws a For each step as a container around its body. */
export type WorkflowFlowNode = Node<WorkflowNodeData, 'workflow' | 'forEach'>;
export type WorkflowFlowEdge = Edge<WorkflowEdgeData, 'workflow'>;

export type WorkflowFlowProjection = Readonly<{
  nodes: WorkflowFlowNode[];
  edges: WorkflowFlowEdge[];
}>;

export type CanvasDecorations = Readonly<{
  issuesByNode: ReadonlyMap<string, number>;
  flowingEdgeIds: ReadonlySet<string>;
  weaveOrder: ReadonlyMap<string, number> | null;
  selectedNodeIds: readonly string[];
  selectedEdgeIds: readonly string[];
  /** Canvas positions of steps being dragged (body steps: in their card). */
  dragPositions: ReadonlyMap<string, Position>;
  /** Client-side body issues by For each ID. */
  bodyIssues: ReadonlyMap<string, readonly BodyIssue[]>;
  /**
   * Sizes React Flow measured, handed back on each projection so the
   * overview map (which reads the projected nodes) can draw them.
   */
  measuredSizes?: ReadonlyMap<string, Size>;
  /** The latest check describes the draft on screen. */
  checked?: boolean;
  /** Output size of each step's last passed test, when known. */
  testOutputBytes?: ReadonlyMap<string, number>;
}>;

const noCanvasDecorations: CanvasDecorations = Object.freeze({
  issuesByNode: new Map<string, number>(),
  flowingEdgeIds: new Set<string>(),
  weaveOrder: null,
  selectedNodeIds: [],
  selectedEdgeIds: [],
  dragPositions: new Map<string, Position>(),
  bodyIssues: new Map<string, readonly BodyIssue[]>(),
});

/** Body steps stay below and right of their body's corner. */
const BODY_EXTENT: CoordinateExtent = [
  [BODY_ORIGIN.x, BODY_ORIGIN.y],
  [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
];

export function definitionIdentity(key: string, version: number) {
  return `${key}@${String(version)}`;
}

export function findDefinition(
  definitions: readonly NodeDefinitionCatalogItem[],
  node: Pick<WorkflowNode, 'definition'>,
): NodeDefinitionCatalogItem | undefined {
  return definitions.find(
    (candidate) =>
      candidate.definition.key === node.definition.key &&
      candidate.definition.version === node.definition.version,
  );
}

type Projection = Readonly<{
  definitions: ReadonlyMap<string, NodeDefinitionCatalogItem>;
  selectedNodes: ReadonlySet<string>;
  selectedEdges: ReadonlySet<string>;
  labels: ReadonlyMap<string, string>;
  decorations: CanvasDecorations;
  nodes: WorkflowFlowNode[];
  edges: WorkflowFlowEdge[];
}>;

type Parent = Readonly<{ id: string; frame: BodyFrame }>;

/**
 * The workflow as React Flow draws it. A For each is a container node and
 * its body's steps are its children (drawn inside it, positioned relative
 * to it), all the way down. The projection never changes the graph.
 */
export function projectWorkflowGraph(
  graph: WorkflowGraphContract,
  definitions: readonly NodeDefinitionCatalogItem[],
  decorations: CanvasDecorations = noCanvasDecorations,
): WorkflowFlowProjection {
  const projection: Projection = {
    definitions: new Map(
      definitions.map((definition) => [
        definitionIdentity(
          definition.definition.key,
          definition.definition.version,
        ),
        definition,
      ]),
    ),
    selectedNodes: new Set(decorations.selectedNodeIds),
    selectedEdges: new Set(decorations.selectedEdgeIds),
    labels: new Map(
      [...indexGraph(graph).nodes.values()].map(({ item }) => [
        item.id,
        stepTitle(item),
      ]),
    ),
    decorations,
    nodes: [],
    edges: [],
  };
  projectLevel(graph, undefined, projection);
  return { nodes: projection.nodes, edges: projection.edges };
}

function projectLevel(
  level: GraphLevel,
  parent: Parent | undefined,
  projection: Projection,
): void {
  const sinks = parent === undefined ? [] : levelSinks(level);
  const result = sinks.length === 1 ? sinks[0] : undefined;
  for (const node of level.nodes) {
    const body = node.structured?.body;
    const frame = isForEach(node)
      ? bodyFrame(body, draggedInBody(body, projection.decorations))
      : undefined;
    projection.nodes.push(
      projectNode(
        node,
        level,
        { parent, frame },
        node.id === result,
        projection,
      ),
    );
    if (frame !== undefined && body !== undefined)
      projectLevel(body, { id: node.id, frame }, projection);
  }
  for (const edge of level.edges)
    projection.edges.push(projectEdge(edge, projection));
}

/** Body steps being dragged, in body coordinates. */
function draggedInBody(
  body: GraphLevel | undefined,
  decorations: CanvasDecorations,
): ReadonlyMap<string, Position> {
  const moving = new Map<string, Position>();
  for (const node of body?.nodes ?? []) {
    const dragged = decorations.dragPositions.get(node.id);
    if (dragged !== undefined) moving.set(node.id, toBodyPosition(dragged));
  }
  return moving;
}

function projectNode(
  node: WorkflowNode,
  level: GraphLevel,
  {
    parent,
    frame,
  }: Readonly<{
    parent: Parent | undefined;
    frame: BodyFrame | undefined;
  }>,
  bodyResult: boolean,
  projection: Projection,
): WorkflowFlowNode {
  const { decorations, labels } = projection;
  const definition = projection.definitions.get(
    definitionIdentity(node.definition.key, node.definition.version),
  );
  const shown =
    parent === undefined
      ? node.position
      : fromBodyPosition(parent.frame.positions.get(node.id) ?? node.position);
  const measured = decorations.measuredSizes?.get(node.id);
  return {
    id: node.id,
    type: isForEach(node) ? 'forEach' : 'workflow',
    position: decorations.dragPositions.get(node.id) ?? shown,
    ...(measured === undefined ? {} : { measured }),
    ...(parent === undefined
      ? {}
      : { parentId: parent.id, extent: BODY_EXTENT }),
    selected: projection.selectedNodes.has(node.id),
    data: {
      label: node.label,
      definitionKey: node.definition.key,
      definitionVersion: node.definition.version,
      family: definition?.family ?? 'unknown',
      lifecycle: definition?.lifecycle,
      inputPorts: shownPorts(node, definition, level, 'inputs'),
      outputPorts: shownPorts(node, definition, level, 'outputs'),
      branching: {
        inputs: (definition?.ports.inputs.length ?? 0) > 1,
        outputs: (definition?.ports.outputs.length ?? 0) > 1,
      },
      links: {
        inputs: portLinks(node, level, 'inputs', labels),
        outputs: portLinks(node, level, 'outputs', labels),
      },
      summary: stepSummary(node),
      testOutputBytes: decorations.testOutputBytes?.get(node.id),
      checked: decorations.checked === true,
      issueCount: decorations.issuesByNode.get(node.id) ?? 0,
      missingConnections: (definition?.connectionRequirements ?? []).filter(
        (requirement) => node.connectionRefs[requirement] === undefined,
      ).length,
      disabled: node.disabled === true,
      unsupported: definition === undefined,
      loop: loopSummary(node),
      body:
        frame === undefined
          ? null
          : {
              width: frame.width,
              height: frame.height,
              issues: decorations.bodyIssues.get(node.id) ?? [],
            },
      bodyResult,
    },
  };
}

function projectEdge(
  edge: WorkflowEdge,
  projection: Projection,
): WorkflowFlowEdge {
  const { decorations, labels } = projection;
  return {
    id: edge.id,
    source: edge.source.nodeId,
    sourceHandle: edge.source.port,
    target: edge.target.nodeId,
    targetHandle: edge.target.port,
    type: 'workflow',
    selected: projection.selectedEdges.has(edge.id),
    data: {
      sourceLabel: labels.get(edge.source.nodeId) ?? 'a step',
      targetLabel: labels.get(edge.target.nodeId) ?? 'a step',
      flowing: decorations.flowingEdgeIds.has(edge.id),
      weaveOrder: decorations.weaveOrder?.get(edge.id) ?? null,
      intoIssue: (decorations.issuesByNode.get(edge.target.nodeId) ?? 0) > 0,
    },
  };
}

export function loopSummary(
  node: Pick<WorkflowNode, 'structured'>,
): LoopSummary | null {
  const structured = node.structured;
  if (structured === undefined) return null;
  return {
    maxIterations: structured.maxIterations,
    maxConcurrency: structured.maxConcurrency,
    steps: structured.body.nodes.map((step) => ({
      id: step.id,
      title: stepTitle(step),
    })),
    inputs: structured.body.inputPorts,
    outputs: structured.body.outputPorts,
  };
}

/** A step's label, or the human name of its type when it has none. */
export function stepTitle(node: Pick<WorkflowNode, 'label' | 'definition'>) {
  return node.label ?? describeStep(node.definition.key).name;
}
