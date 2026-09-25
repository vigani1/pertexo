import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import type { Edge, Node } from '@xyflow/react';
import { describeStep } from '@/features/catalog/presentation.public';

type WorkflowNode = WorkflowGraphContract['nodes'][number];
type Position = Readonly<{ x: number; y: number }>;

/**
 * A For each step's body as its card shows it (ADR 020): the steps that run
 * once per item, the body's `item`/`ordinal` inputs and `result` output, and
 * the bounds on items and concurrency. The graph itself is untouched.
 */
export type LoopSummary = Readonly<{
  maxIterations: number;
  maxConcurrency: number;
  /** The body's steps, in stored order. */
  steps: readonly Readonly<{ id: string; title: string }>[];
  inputs: readonly string[];
  outputs: readonly string[];
}>;

interface WorkflowNodeData extends Record<string, unknown> {
  label: string | undefined;
  definitionKey: string;
  definitionVersion: number;
  family: NodeDefinitionCatalogItem['family'] | 'unknown';
  lifecycle: NodeDefinitionCatalogItem['lifecycle'] | undefined;
  inputPorts: readonly string[];
  outputPorts: readonly string[];
  issueCount: number;
  missingConnections: number;
  disabled: boolean;
  unsupported: boolean;
  /** The For each body, or null when the step has none yet. */
  loop: LoopSummary | null;
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
  dragPositions: ReadonlyMap<string, Position>;
}>;

const noCanvasDecorations: CanvasDecorations = Object.freeze({
  issuesByNode: new Map<string, number>(),
  flowingEdgeIds: new Set<string>(),
  weaveOrder: null,
  selectedNodeIds: [],
  selectedEdgeIds: [],
  dragPositions: new Map<string, Position>(),
});

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

export function projectWorkflowGraph(
  graph: WorkflowGraphContract,
  definitions: readonly NodeDefinitionCatalogItem[],
  decorations: CanvasDecorations = noCanvasDecorations,
): WorkflowFlowProjection {
  const definitionByIdentity = new Map(
    definitions.map((definition) => [
      definitionIdentity(
        definition.definition.key,
        definition.definition.version,
      ),
      definition,
    ]),
  );
  const selectedNodes = new Set(decorations.selectedNodeIds);
  const selectedEdges = new Set(decorations.selectedEdgeIds);
  const labels = new Map(graph.nodes.map((node) => [node.id, stepTitle(node)]));
  return {
    nodes: graph.nodes.map((node) => {
      const definition = definitionByIdentity.get(
        definitionIdentity(node.definition.key, node.definition.version),
      );
      return {
        id: node.id,
        type: isForEach(node) ? 'forEach' : 'workflow',
        position: decorations.dragPositions.get(node.id) ?? node.position,
        selected: selectedNodes.has(node.id),
        data: {
          label: node.label,
          definitionKey: node.definition.key,
          definitionVersion: node.definition.version,
          family: definition?.family ?? 'unknown',
          lifecycle: definition?.lifecycle,
          inputPorts:
            definition?.ports.inputs ?? Object.keys(node.inputMappings),
          outputPorts: definition?.ports.outputs ?? [],
          issueCount: decorations.issuesByNode.get(node.id) ?? 0,
          missingConnections: (definition?.connectionRequirements ?? []).filter(
            (requirement) => node.connectionRefs[requirement] === undefined,
          ).length,
          disabled: node.disabled === true,
          unsupported: definition === undefined,
          loop: loopSummary(node),
        },
      } satisfies WorkflowFlowNode;
    }),
    edges: graph.edges.map(
      (edge) =>
        ({
          id: edge.id,
          source: edge.source.nodeId,
          sourceHandle: edge.source.port,
          target: edge.target.nodeId,
          targetHandle: edge.target.port,
          type: 'workflow',
          selected: selectedEdges.has(edge.id),
          data: {
            sourceLabel: labels.get(edge.source.nodeId) ?? 'a step',
            targetLabel: labels.get(edge.target.nodeId) ?? 'a step',
            flowing: decorations.flowingEdgeIds.has(edge.id),
            weaveOrder: decorations.weaveOrder?.get(edge.id) ?? null,
            intoIssue:
              (decorations.issuesByNode.get(edge.target.nodeId) ?? 0) > 0,
          },
        }) satisfies WorkflowFlowEdge,
    ),
  };
}

const FOR_EACH_KEY = 'core.foreach';

/** A For each step, drawn and inspected as a container for its body. */
export function isForEach(
  node: Pick<WorkflowNode, 'definition' | 'structured'>,
): boolean {
  return node.definition.key === FOR_EACH_KEY || node.structured !== undefined;
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
