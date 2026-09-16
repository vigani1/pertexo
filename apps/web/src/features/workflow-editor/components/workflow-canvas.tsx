import '@xyflow/react/dist/style.css';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type NodeMouseHandler,
  type OnNodeDrag,
} from '@xyflow/react';
import { useCallback, useMemo, useRef } from 'react';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import {
  connectWorkflowNodes,
  moveWorkflowNode,
  projectWorkflowGraph,
  type WorkflowFlowEdge,
  type WorkflowFlowNode,
} from '../model/graph-adapter';
import { useEditorStore } from '../model/editor-store-context';
import { WorkflowEdge } from './canvas/workflow-edge';
import { WorkflowNodeCard } from './canvas/workflow-node-card';
import { SelectionToolbar } from './canvas/selection-toolbar';

const nodeTypes = Object.freeze({ workflow: WorkflowNodeCard });
const edgeTypes = Object.freeze({ workflow: WorkflowEdge });

export function WorkflowCanvas({
  definitions,
  editable,
  onSelectionRequest,
  onDeleteRequest,
}: Readonly<{
  definitions: readonly NodeDefinitionCatalogItem[];
  editable: boolean;
  onSelectionRequest: (nodeId: string | null) => void;
  onDeleteRequest: (nodeId: string) => void;
}>) {
  const graph = useEditorStore((state) => state.graph);
  const selectedNodeId = useEditorStore((state) => state.selectedNodeId);
  const transact = useEditorStore((state) => state.transact);
  const canvasRef = useRef<HTMLDivElement>(null);
  const projection = useMemo(
    () => projectWorkflowGraph(graph, definitions),
    [definitions, graph],
  );
  const onConnect = useCallback(
    (connection: Connection) => {
      if (!editable) return;
      const next = connectWorkflowNodes(graph, connection);
      if (next !== null) transact(next);
    },
    [editable, graph, transact],
  );
  const onNodeClick = useCallback<NodeMouseHandler<WorkflowFlowNode>>(
    (_event, node) => {
      canvasRef.current?.focus();
      onSelectionRequest(node.id);
    },
    [onSelectionRequest],
  );
  const onNodeDragStop = useCallback<OnNodeDrag<WorkflowFlowNode>>(
    (_event, node) => {
      if (editable) transact(moveWorkflowNode(graph, node.id, node.position));
    },
    [editable, graph, transact],
  );

  return (
    <div
      ref={canvasRef}
      data-workflow-canvas
      tabIndex={0}
      className="relative h-full min-h-[32rem] overflow-hidden bg-[radial-gradient(circle_at_72%_12%,rgb(0_218_243/7%),transparent_32rem),radial-gradient(circle_at_12%_88%,rgb(208_188_255/5%),transparent_34rem),var(--background)] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      aria-label="Workflow canvas"
    >
      <ReactFlow<WorkflowFlowNode, WorkflowFlowEdge>
        nodes={projection.nodes}
        edges={projection.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={() => {
          canvasRef.current?.focus();
          onSelectionRequest(null);
        }}
        onNodeDragStop={onNodeDragStop}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={1.8}
        deleteKeyCode={null}
        nodesDraggable={editable}
        nodesConnectable={editable}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} color="rgba(185, 214, 219, 0.12)" />
        <MiniMap
          pannable
          zoomable
          position="bottom-left"
          className="!m-4 !overflow-hidden !rounded-lg !border !border-primary/20 !bg-card/90 !shadow-[0_0_28px_rgb(0_218_243/10%)]"
          maskColor="rgb(0 0 0 / 28%)"
          bgColor="rgb(12 14 17 / 0.92)"
          nodeBorderRadius={4}
          nodeStrokeColor="rgb(195 245 255)"
          nodeStrokeWidth={2}
          nodeColor="rgb(87 216 232)"
        />
        <Controls
          position="bottom-right"
          showInteractive={false}
          className="!m-4 !overflow-hidden !rounded-lg !border !border-primary/20 !bg-card/90 !shadow-[0_0_22px_rgb(0_218_243/10%)]"
        />
      </ReactFlow>
      {editable && selectedNodeId !== null ? (
        <SelectionToolbar
          onRemove={() => {
            onDeleteRequest(selectedNodeId);
          }}
        />
      ) : null}
    </div>
  );
}
