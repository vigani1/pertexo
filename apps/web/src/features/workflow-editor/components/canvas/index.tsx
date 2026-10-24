import { CanvasNote } from './notes/card';
import { useNoteProjection } from './notes/use-projection';
import { isNoteFlowId, type CanvasFlowNode } from './notes/types';
import { useAppearance } from '@/lib/appearance/use-choice';
import '@xyflow/react/dist/style.css';
import {
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
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
  type RefObject,
  useRef,
} from 'react';
import { stepSampleBindings } from '@pertexo/workflow-model';
import { currentSampleState } from '@/features/workflow-publish/step-samples.public';
import type {
  StepSampleMetadata,
  NodeDefinitionCatalogItem,
} from '@pertexo/contracts';
import { levelPositions } from '../../model/graph/for-each-body-layout';
import { forEachBodyIssues } from '../../model/graph/for-each-body-rules';
import {
  projectWorkflowGraph,
  type CanvasDecorations,
  type WorkflowFlowEdge,
  type WorkflowFlowNode,
} from '../../model/graph/adapter';
import {
  linkWorkflowNodes,
  moveWorkflowNodes,
  type PortRef,
} from '../../model/graph/commands';
import { useEditorStore, useEditorStoreApi } from '../../model/state/context';
import { canLinkSteps } from '../../model/graph/scopes';
import { gestureEndPoint, portDropSource } from '../../model/quick-add';
import { STEP_DRAG_TYPE } from '../../model/step-catalog';
import { CanvasActionsContext } from '../../model/canvas/actions-context';
import { useCanvasFraming } from './use-framing';
import { CanvasZoomLens } from './zoom-lens';
import { ForEachNodeCard } from './cards/for-each';
import { WorkflowEdge } from './workflow-edge';
import { WorkflowNodeCard } from './cards/node';

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

type Position = Readonly<{ x: number; y: number }>;
type Size = Readonly<{ width: number; height: number }>;

export type CanvasOverlays = Pick<
  CanvasDecorations,
  | 'issuesByNode'
  | 'flowingEdgeIds'
  | 'weaveOrder'
  | 'testOutputBytes'
  | 'testStatuses'
>;

/**
 * The workflow drawn on the weave. Gestures become editor commands: drags
 * move steps as one change when they end, selection goes through the
 * editor's guard, ⌫ is handled by the editor rather than React Flow, and a
 * link dropped on empty canvas (or an empty part of a For each body)
 * asks which step to add there. For each bodies are edited in place: their
 * steps are the container's children, and links never cross a body's
 * edge.
 */
export function WorkflowCanvas({
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
}: Readonly<{
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
}>) {
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
          onNodeClick={(event, node) => {
            if (node.type === 'note') return;
            const previous = lastTap.current;
            const now = event.timeStamp;
            lastTap.current = { id: node.id, at: now };
            if (previous?.id === node.id && now - previous.at < DOUBLE_TAP_MS) {
              lastTap.current = undefined;
              onOpenStep(node.id);
            }
          }}
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
              fit(true);
            }}
          />
        </ReactFlow>
      </CanvasActionsContext>
      {children}
    </div>
  );
}

/**
 * The graph as React Flow draws it, and the node changes React Flow reports
 * back: drags move steps as one change when they end, selection goes
 * through the editor's guard, and measured sizes return with each
 * projection.
 */
function useCanvasProjection({
  definitions,
  overlays,
  samples,
  editable,
  onSelectNodes,
}: Readonly<{
  definitions: readonly NodeDefinitionCatalogItem[];
  overlays: CanvasOverlays;
  samples: readonly StepSampleMetadata[] | undefined;
  editable: boolean;
  onSelectNodes: (nodeIds: readonly string[]) => void;
}>) {
  const store = useEditorStoreApi();
  const graph = useEditorStore((state) => state.graph);
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const selectedEdgeIds = useEditorStore((state) => state.selectedEdgeIds);
  const [dragPositions, setDragPositions] = useState<
    ReadonlyMap<string, Position>
  >(() => new Map());
  // React Flow marks its own copy of a node selected before asking us. When
  // the editor's guard declines a selection, fresh node objects re-sync it.
  const [selectionResync, setSelectionResync] = useState(0);
  // Measured sizes go back into every projection: React Flow's overview map
  // draws the nodes we pass it, and a node without a size isn't drawn.
  const [measuredSizes, setMeasuredSizes] = useState<ReadonlyMap<string, Size>>(
    () => new Map(),
  );

  const sampleStates = useMemo(() => {
    if (samples === undefined)
      return new Map<string, StepSampleMetadata['state']>();
    const bindings = stepSampleBindings(graph);
    return new Map(
      samples.map((sample) => [
        sample.nodeId,
        currentSampleState(sample, bindings.get(sample.nodeId)),
      ]),
    );
  }, [graph, samples]);
  const projection = useMemo(
    () =>
      projectWorkflowGraph(graph, definitions, {
        ...overlays,
        sampleStates,
        selectedNodeIds,
        selectedEdgeIds,
        dragPositions,
        bodyIssues: forEachBodyIssues(graph),
        measuredSizes,
      }),
    // selectionResync only forces fresh node objects for React Flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      definitions,
      dragPositions,
      graph,
      measuredSizes,
      overlays,
      sampleStates,
      selectedEdgeIds,
      selectedNodeIds,
      selectionResync,
    ],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<WorkflowFlowNode>[]) => {
      const moving = new Map<string, Position>();
      const settled = new Map<string, Position>();
      const sized = new Map<string, Size>();
      let selection: Set<string> | undefined;
      for (const change of changes) {
        if (change.type === 'dimensions') {
          if (change.dimensions !== undefined)
            sized.set(change.id, change.dimensions);
        } else if (change.type === 'select') {
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
      if (sized.size > 0)
        setMeasuredSizes((current) => new Map([...current, ...sized]));
      if (moving.size > 0)
        setDragPositions((current) => new Map([...current, ...moving]));
      if (settled.size === 0) return;
      const state = store.getState();
      state.transact(
        moveWorkflowNodes(state.graph, levelPositions(state.graph, settled)),
        { coalesceKey: `move:${[...settled.keys()].join(',')}` },
      );
      setDragPositions((current) => {
        const next = new Map(current);
        for (const id of settled.keys()) next.delete(id);
        return next;
      });
    },
    [dragPositions, editable, onSelectNodes, store],
  );
  return { projection, onNodesChange } as const;
}

/**
 * Links drawn on the canvas: only between steps on the same level (a
 * body's steps link only to each other), added as one change, and a
 * link dropped on empty canvas opens quick add there.
 */
function useLinkGestures({
  store,
  editable,
  onPortDrop,
}: Readonly<{
  store: ReturnType<typeof useEditorStoreApi>;
  editable: boolean;
  onPortDrop: (from: PortRef, point: Position) => void;
}>) {
  const isValidConnection = useCallback(
    (link: Connection | Edge) => {
      const graph = store.getState().graph;
      return (
        canLinkSteps(graph, link.source, link.target) &&
        linkWorkflowNodes(graph, {
          source: link.source,
          target: link.target,
          sourceHandle: link.sourceHandle ?? null,
          targetHandle: link.targetHandle ?? null,
        }) !== null
      );
    },
    [store],
  );
  const onConnect = useCallback(
    (link: Connection) => {
      if (!editable) return;
      const state = store.getState();
      const next = linkWorkflowNodes(state.graph, link);
      if (next !== null) state.transact(next);
    },
    [editable, store],
  );
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      const point = gestureEndPoint(event);
      if (!editable || point === null) return;
      const from = portDropSource({ state, endedOverStep: isOverStep(point) });
      if (from !== null) onPortDrop(from, point);
    },
    [editable, onPortDrop],
  );
  return { isValidConnection, onConnect, onConnectEnd } as const;
}

/**
 * Whether a point in the viewport is over a step card rather than canvas.
 * The empty part of a For each body counts as canvas: body steps are drawn
 * above it, so a point over one of them finds that step first.
 */
function isOverStep(point: Position): boolean {
  if (typeof document.elementFromPoint !== 'function') return false;
  const element = document.elementFromPoint(point.x, point.y);
  if (element === null) return false;
  return (
    element.closest('.react-flow__node') !== null &&
    element.closest('[data-for-each-body]') === null
  );
}
