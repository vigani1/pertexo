import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import type { Connection, Edge, Node } from '@xyflow/react';

type WorkflowNode = WorkflowGraphContract['nodes'][number];
type WorkflowEdge = WorkflowGraphContract['edges'][number];

interface WorkflowNodeData extends Record<string, unknown> {
  label: string;
  definitionKey: string;
  definitionVersion: number;
  family: NodeDefinitionCatalogItem['family'] | 'unknown';
  inputPorts: readonly string[];
  outputPorts: readonly string[];
  configurationCount: number;
  connectionCount: number;
  unsupported: boolean;
}

export type WorkflowFlowNode = Node<WorkflowNodeData, 'workflow'>;
export type WorkflowFlowEdge = Edge<Record<string, never>, 'workflow'>;

export type WorkflowFlowProjection = Readonly<{
  nodes: WorkflowFlowNode[];
  edges: WorkflowFlowEdge[];
}>;

function definitionIdentity(key: string, version: number) {
  return `${key}@${String(version)}`;
}

export function projectWorkflowGraph(
  graph: WorkflowGraphContract,
  definitions: readonly NodeDefinitionCatalogItem[],
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
  return {
    nodes: graph.nodes.map((node) => {
      const definition = definitionByIdentity.get(
        definitionIdentity(node.definition.key, node.definition.version),
      );
      return {
        id: node.id,
        type: 'workflow',
        position: node.position,
        data: {
          label: node.label ?? node.definition.key,
          definitionKey: node.definition.key,
          definitionVersion: node.definition.version,
          family: definition?.family ?? 'unknown',
          inputPorts:
            definition?.ports.inputs ?? Object.keys(node.inputMappings),
          outputPorts: definition?.ports.outputs ?? [],
          configurationCount: Object.keys(node.config).length,
          connectionCount: Object.keys(node.connectionRefs).length,
          unsupported: definition === undefined,
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
          data: {},
        }) satisfies WorkflowFlowEdge,
    ),
  };
}

export function addDefinitionNode(
  graph: WorkflowGraphContract,
  definition: NodeDefinitionCatalogItem,
  position: Readonly<{ x: number; y: number }>,
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
  position: Readonly<{ x: number; y: number }>,
): WorkflowGraphContract {
  const target = graph.nodes.find((node) => node.id === nodeId);
  if (
    target === undefined ||
    (target.position.x === position.x && target.position.y === position.y)
  )
    return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === nodeId ? { ...node, position } : node,
    ),
  };
}

export function updateWorkflowNode(
  graph: WorkflowGraphContract,
  nodeId: string,
  update: Readonly<{
    label?: string | undefined;
    config?: WorkflowNode['config'];
    inputMappings?: WorkflowNode['inputMappings'];
    connectionRefs?: WorkflowNode['connectionRefs'];
  }>,
): WorkflowGraphContract {
  if (!graph.nodes.some((node) => node.id === nodeId)) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      const updated = { ...node, ...update };
      if (updated.label !== undefined) return updated;
      delete updated.label;
      return updated;
    }),
  };
}

export function removeWorkflowNode(
  graph: WorkflowGraphContract,
  nodeId: string,
): WorkflowGraphContract {
  if (!graph.nodes.some((node) => node.id === nodeId)) return graph;
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => node.id !== nodeId),
    edges: graph.edges.filter(
      (edge) => edge.source.nodeId !== nodeId && edge.target.nodeId !== nodeId,
    ),
  };
}

export function connectWorkflowNodes(
  graph: WorkflowGraphContract,
  connection: Connection,
  id: string = crypto.randomUUID(),
): WorkflowGraphContract | null {
  if (connection.sourceHandle === null || connection.targetHandle === null)
    return null;
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
