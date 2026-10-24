import { CanvasNote } from './notes/card';
import { useNoteProjection } from './notes/use-projection';
import { isNoteFlowId, type CanvasFlowNode } from './notes/types';
import { useAppearance } from '@/lib/appearance/use-choice';
import '@xyflow/react/dist/style.css';
import {
  ReactFlow,
  useReactFlow,
  type EdgeChange,
  type NodeChange,
  type NodeMouseHandler,
} from '@xyflow/react';
import {
  useCallback,
  useMemo,
  type DragEvent,
  type ReactNode,
  type RefObject,
  useRef,
} from 'react';
import type {
  StepSampleMetadata,
  NodeDefinitionCatalogItem,
} from '@pertexo/contracts';
import type { WorkflowFlowEdge } from '../../model/graph/adapter';
import type { PortRef } from '../../model/graph/commands';
import { useEditorStoreApi } from '../../model/state/context';
import { STEP_DRAG_TYPE } from '../../model/step-catalog';
import { CanvasActionsContext } from '../../model/canvas/actions-context';
import { useCanvasFraming } from './use-framing';
import { CanvasZoomLens } from './zoom-lens';
import { ForEachNodeCard } from './cards/for-each';
import { WorkflowEdge } from './workflow-edge';
import { WorkflowNodeCard } from './cards/node';
import type { Position } from './projection';
import type { CanvasOverlays } from './projection';
import { useCanvasProjection } from './projection';
import { useLinkGestures } from './gestures';

// Module-level so React Flow never sees new node types between renders.
const nodeTypes = Object.freeze({
  note: CanvasNote,
  workflow: WorkflowNodeCard,
  forEach: ForEachNodeCard,
});

const edgeTypes = Object.freeze({ workflow: WorkflowEdge });

const multiSelectionKeys = ['Meta', 'Control', 'Shift'];

// Two taps on one step within this long open it.
const DOUBLE_TAP_MS = 350;

/**
 * The workflow drawn on the weave. Gestures become editor commands: drags
 * move steps as one change when they end, selection goes through the
 * editor's guard, ⌫ is handled by the editor rather than React Flow, and a
 * link dropped on empty canvas (or an empty part of a For each body)
 * asks which step to add there. For each bodies are edited in place: their
 * steps are the container's children, and links never cross a body's
 * edge.
 */
type WorkflowCanvasProps = Readonly<{
  definitions: readonly NodeDefinitionCatalogItem[];
  editable: boolean;
  overlays: CanvasOverlays;
  samples?: readonly StepSampleMetadata[] | undefined;
  containerRef: RefObject<HTMLDivElement | null>;
  onSelectNodes: (nodeIds: readonly string[]) => void;
  onRemoveEdge: (edgeId: string) => void;
  onDropStep: (identity: string, position: Position) => void;
  /** A link from `from` ended over empty canvas at `point`. */
  onPortDrop: (from: PortRef, point: Position) => void;
  onAddToBody: (loopId: string, opener: HTMLElement) => void;
  /** A step was double-clicked or double-tapped: show it in its panel. */
  onOpenStep: (nodeId: string) => void;
  children?: ReactNode;
}>;

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  const {
    onNodeClick,
    containerRef,
    editable,
    onDrop,
    actions,
    theme,
    canvasNodes,
    projection,
    onCanvasNodesChange,
    onEdgesChange,
    linkGestures,
    fit,
    children,
  } = useCanvasInteraction(props);
  return (
    <div
      ref={containerRef}
      data-workflow-canvas
      tabIndex={0}
      aria-label="Workflow canvas"
      role="region"
      className="weave absolute inset-0 overflow-hidden -outline-offset-2"
      onKeyDown={(event) => {
        // React Flow blurs a step on Escape, which would leave focus on the
        // page; keep it on the canvas, as a click on empty canvas does.
        if (
          event.key === 'Escape' &&
          event.target instanceof Element &&
          event.target.classList.contains('react-flow__node')
        )
          event.currentTarget.focus();
      }}
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
        <ReactFlow<CanvasFlowNode, WorkflowFlowEdge>
          colorMode={theme}
          nodes={canvasNodes}
          edges={projection.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onCanvasNodesChange}
          onEdgesChange={onEdgesChange}
          isValidConnection={linkGestures.isValidConnection}
          onConnect={linkGestures.onConnect}
          onConnectEnd={linkGestures.onConnectEnd}
          onNodeClick={onNodeClick}
          onPaneClick={(event) => {
            event.currentTarget
              .closest<HTMLElement>('[data-workflow-canvas]')
              ?.focus();
          }}
          minZoom={0.2}
          maxZoom={1.8}
          deleteKeyCode={null}
          multiSelectionKeyCode={multiSelectionKeys}
          selectionKeyCode="Shift"
          nodesDraggable={editable}
          nodesConnectable={editable}
          proOptions={{ hideAttribution: true }}
          // React Flow's own stylesheet sets the *-default variables and
          // isn't layered, so it outranks utilities; the plain variables it
          // reads first are ours to set.
          className="!bg-transparent [--xy-edge-stroke:color-mix(in_srgb,var(--muted-foreground)_35%,transparent)] [--xy-connectionline-stroke:var(--primary)] [--xy-selection-background-color:color-mix(in_srgb,var(--primary)_8%,transparent)] [--xy-selection-border:1px_solid_color-mix(in_srgb,var(--primary)_45%,transparent)]"
        >
          <CanvasZoomLens
            onFit={() => {
              fit({ animate: true });
            }}
          />
        </ReactFlow>
      </CanvasActionsContext>
      {children}
    </div>
  );
}

function useCanvasInteraction({
  definitions,
  editable,
  overlays,
  samples,
  containerRef,
  onSelectNodes,
  onRemoveEdge,
  onDropStep,
  onPortDrop,
  onAddToBody,
  onOpenStep,
  children,
}: WorkflowCanvasProps) {
  // Timed by hand: a phone's double tap doesn't reliably fire dblclick.
  const { theme } = useAppearance();
  const lastTap = useRef<Readonly<{ id: string; at: number }>>(undefined);
  const store = useEditorStoreApi();
  const { screenToFlowPosition } = useReactFlow();
  const fit = useCanvasFraming(containerRef);
  const { projection, onNodesChange } = useCanvasProjection({
    definitions,
    overlays,
    samples,
    editable,
    onSelectNodes,
  });

  const { nodes: noteNodes, onChanges: onNoteChanges } = useNoteProjection({
    editable,
  });
  const canvasNodes = useMemo(
    () => [...noteNodes, ...projection.nodes],
    [noteNodes, projection.nodes],
  );
  const onCanvasNodesChange = useCallback(
    (changes: NodeChange<CanvasFlowNode>[]) => {
      const mountedChanges = changes.filter(
        (
          change,
        ): change is Exclude<
          NodeChange<CanvasFlowNode>,
          { type: 'add' | 'replace' }
        > => change.type !== 'add' && change.type !== 'replace',
      );
      onNoteChanges(mountedChanges.filter((change) => isNoteFlowId(change.id)));
      onNodesChange(
        mountedChanges.filter((change) => !isNoteFlowId(change.id)),
      );
    },
    [onNoteChanges, onNodesChange],
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

  const linkGestures = useLinkGestures({ store, editable, onPortDrop });

  const actions = useMemo(
    () => ({ editable, removeEdge: onRemoveEdge, addToBody: onAddToBody }),
    [editable, onAddToBody, onRemoveEdge],
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

  const onNodeClick: NodeMouseHandler<CanvasFlowNode> = (event, node) => {
    if (node.type === 'note') return;
    const previous = lastTap.current;
    const now = event.timeStamp;
    lastTap.current = { id: node.id, at: now };
    if (previous?.id === node.id && now - previous.at < DOUBLE_TAP_MS) {
      lastTap.current = undefined;
      onOpenStep(node.id);
    }
  };
  return {
    onNodeClick,
    containerRef,
    editable,
    onDrop,
    actions,
    theme,
    canvasNodes,
    projection,
    onCanvasNodesChange,
    onEdgesChange,
    linkGestures,
    fit,
    children,
  } as const;
}
