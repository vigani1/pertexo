import '@xyflow/react/dist/style.css';
import {
  ReactFlow,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
} from '@xyflow/react';
import {
  useCallback,
  useMemo,
  useState,
  type DragEvent,
  type ReactNode,
  type Ref,
} from 'react';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import {
  projectWorkflowGraph,
  type CanvasDecorations,
  type WorkflowFlowEdge,
  type WorkflowFlowNode,
} from '../../model/graph-adapter';
import {
  connectWorkflowNodes,
  moveWorkflowNodes,
  type PortRef,
} from '../../model/graph-commands';
import {
  useEditorStore,
  useEditorStoreApi,
} from '../../model/editor-store-context';
import { gestureEndPoint, portDropSource } from '../../model/quick-add';
import { STEP_DRAG_TYPE } from '../../model/step-catalog';
import { CanvasActionsContext } from '../../model/canvas-actions-context';
import { CanvasZoomLens } from './canvas-zoom-lens';
import { WorkflowEdge } from './workflow-edge';
import { WorkflowNodeCard } from './workflow-node-card';

const nodeTypes = Object.freeze({ workflow: WorkflowNodeCard });
const edgeTypes = Object.freeze({ workflow: WorkflowEdge });
const multiSelectionKeys = ['Meta', 'Control', 'Shift'];

type Position = Readonly<{ x: number; y: number }>;

export type CanvasOverlays = Pick<
  CanvasDecorations,
  'issuesByNode' | 'flowingEdgeIds' | 'weaveOrder'
>;

/**
 * The workflow drawn on the weave. Gestures become editor commands: drags
 * move steps as one change when they end, selection goes through the
 * editor's guard, ⌫ is handled by the editor rather than React Flow, and a
 * connection dropped on empty canvas asks which step to add there.
 */
export function WorkflowCanvas({
  definitions,
  editable,
  overlays,
  containerRef,
  onSelectNodes,
  onRemoveEdge,
  onDropStep,
  onPortDrop,
  children,
}: Readonly<{
  definitions: readonly NodeDefinitionCatalogItem[];
  editable: boolean;
  overlays: CanvasOverlays;
  containerRef: Ref<HTMLDivElement>;
  onSelectNodes: (nodeIds: readonly string[]) => void;
  onRemoveEdge: (edgeId: string) => void;
  onDropStep: (identity: string, position: Position) => void;
  /** A connection from `from` ended over empty canvas at `point`. */
  onPortDrop: (from: PortRef, point: Position) => void;
  children?: ReactNode;
}>) {
  const store = useEditorStoreApi();
  const graph = useEditorStore((state) => state.graph);
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const selectedEdgeIds = useEditorStore((state) => state.selectedEdgeIds);
  const { screenToFlowPosition } = useReactFlow();
  const [dragPositions, setDragPositions] = useState<
    ReadonlyMap<string, Position>
  >(() => new Map());
  // React Flow marks its own copy of a node selected before asking us. When
  // the editor's guard declines a selection, fresh node objects re-sync it.
  const [selectionResync, setSelectionResync] = useState(0);

  const projection = useMemo(
    () =>
      projectWorkflowGraph(graph, definitions, {
        ...overlays,
        selectedNodeIds,
        selectedEdgeIds,
        dragPositions,
      }),
    // selectionResync only forces fresh node objects for React Flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      definitions,
      dragPositions,
      graph,
      overlays,
      selectedEdgeIds,
      selectedNodeIds,
      selectionResync,
    ],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<WorkflowFlowNode>[]) => {
      const moving = new Map<string, Position>();
      const settled = new Map<string, Position>();
      let selection: Set<string> | undefined;
      for (const change of changes) {
        if (change.type === 'select') {
          selection ??= new Set(store.getState().selectedNodeIds);
          if (change.selected) selection.add(change.id);
          else selection.delete(change.id);
        } else if (change.type === 'position' && editable) {
          const position = change.position ?? dragPositions.get(change.id);
          if (position === undefined) continue;
          if (change.dragging === true) moving.set(change.id, position);
          else settled.set(change.id, position);
        }
      }
      if (selection !== undefined) {
        const requested = [...selection];
        onSelectNodes(requested);
        const applied = new Set(store.getState().selectedNodeIds);
        if (
          applied.size !== requested.length ||
          requested.some((id) => !applied.has(id))
        )
          setSelectionResync((current) => current + 1);
      }
      if (moving.size > 0)
        setDragPositions((current) => new Map([...current, ...moving]));
      if (settled.size === 0) return;
      const state = store.getState();
      state.transact(moveWorkflowNodes(state.graph, settled), {
        coalesceKey: `move:${[...settled.keys()].join(',')}`,
      });
      setDragPositions((current) => {
        const next = new Map(current);
        for (const id of settled.keys()) next.delete(id);
        return next;
      });
    },
    [dragPositions, editable, onSelectNodes, store],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<WorkflowFlowEdge>[]) => {
      const selection = new Set(store.getState().selectedEdgeIds);
      let changed = false;
      for (const change of changes) {
        if (change.type !== 'select') continue;
        changed = true;
        if (change.selected) selection.add(change.id);
        else selection.delete(change.id);
      }
      if (changed) store.getState().selectEdges([...selection]);
    },
    [store],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!editable) return;
      const state = store.getState();
      const next = connectWorkflowNodes(state.graph, connection);
      if (next !== null) state.transact(next);
    },
    [editable, store],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      const point = gestureEndPoint(event);
      if (!editable || point === null) return;
      const from = portDropSource(state, isOverStep(point));
      if (from !== null) onPortDrop(from, point);
    },
    [editable, onPortDrop],
  );

  const actions = useMemo(
    () => ({ editable, removeEdge: onRemoveEdge }),
    [editable, onRemoveEdge],
  );

  function onDrop(event: DragEvent<HTMLDivElement>) {
    const identity = event.dataTransfer.getData(STEP_DRAG_TYPE);
    if (!editable || identity === '') return;
    event.preventDefault();
    onDropStep(
      identity,
      screenToFlowPosition({ x: event.clientX, y: event.clientY }),
    );
  }

  return (
    <div
      ref={containerRef}
      data-workflow-canvas
      tabIndex={0}
      aria-label="Workflow canvas"
      role="region"
      className="weave absolute inset-0 overflow-hidden outline-none"
      onDragOver={(event) => {
        if (!editable || !event.dataTransfer.types.includes(STEP_DRAG_TYPE))
          return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={onDrop}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_55%_40%,transparent_30%,color-mix(in_srgb,var(--background)_85%,transparent)_90%)]"
      />
      <CanvasActionsContext value={actions}>
        <ReactFlow<WorkflowFlowNode, WorkflowFlowEdge>
          nodes={projection.nodes}
          edges={projection.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          onPaneClick={(event) => {
            event.currentTarget
              .closest<HTMLElement>('[data-workflow-canvas]')
              ?.focus();
          }}
          fitView
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          minZoom={0.2}
          maxZoom={1.8}
          deleteKeyCode={null}
          multiSelectionKeyCode={multiSelectionKeys}
          selectionKeyCode="Shift"
          nodesDraggable={editable}
          nodesConnectable={editable}
          proOptions={{ hideAttribution: true }}
          className="!bg-transparent [--xy-edge-stroke-default:color-mix(in_srgb,var(--muted-foreground)_35%,transparent)] [--xy-connectionline-stroke-default:var(--primary)] [--xy-selection-background-color-default:color-mix(in_srgb,var(--primary)_8%,transparent)] [--xy-selection-border-default:1px_solid_color-mix(in_srgb,var(--primary)_45%,transparent)]"
        >
          <CanvasZoomLens />
        </ReactFlow>
      </CanvasActionsContext>
      {children}
    </div>
  );
}

/** Whether a point in the viewport is over a step card rather than canvas. */
function isOverStep(point: Position): boolean {
  if (typeof document.elementFromPoint !== 'function') return false;
  const step = document
    .elementFromPoint(point.x, point.y)
    ?.closest('.react-flow__node');
  return step !== null && step !== undefined;
}
