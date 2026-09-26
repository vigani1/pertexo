import '@xyflow/react/dist/style.css';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import {
  BaseEdge,
  Controls,
  Handle,
  Position,
  ReactFlow,
  getSmoothStepPath,
  useReactFlow,
  useStore,
  useStoreApi,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { Status, type StatusTone } from '@/components/ui/status';
import { useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';
import { projectRunGraph, type GraphStepStatus } from '../../model/run-graph';
import type { ThreadRow } from '../../model/thread-view';
import { toneBorderClass } from '../../model/tone-styles';

interface RunNodeData extends Record<string, unknown> {
  label: string;
  kind: string;
  tone: StatusTone;
  statusLabel: string;
  status: GraphStepStatus;
  invocations: number;
  selected: boolean;
  inputs: readonly string[];
  outputs: readonly string[];
}

interface RunEdgeData extends Record<string, unknown> {
  tone: StatusTone;
  active: boolean;
  branch?: string;
  skipped: boolean;
}

type RunNode = Node<RunNodeData, 'runNode'>;
type RunEdge = Edge<RunEdgeData, 'runEdge'>;

const nodeTypes = Object.freeze({ runNode: WorkflowRunNode });
const edgeTypes = Object.freeze({ runEdge: WorkflowRunEdge });

/** Below this zoom, step names get too small to read. */
const READABLE_ZOOM = 0.72;
// Fitting never shrinks names below readable; a larger run pans instead.
const FIT_OPTIONS = {
  padding: 0.12,
  maxZoom: 1,
  minZoom: READABLE_ZOOM,
} as const;
// A phone shows the whole run first: its shape matters more than reading
// every name, and a tap on a step opens it.
const PHONE_FIT_OPTIONS = { ...FIT_OPTIONS, minZoom: 0.2 } as const;
const PHONE_MEDIA_QUERY = '(max-width: 47.999rem)';

/** Centre on `focus`, but keep the view filled with the map where it can. */
function clampCentre(
  focus: number,
  start: number,
  length: number,
  halfView: number,
): number {
  const low = start + halfView;
  const high = start + length - halfView;
  if (low > high) return start + length / 2;
  return Math.min(Math.max(focus, low), high);
}

/**
 * The map first fits whole (the `fitView` prop, once its steps are
 * measured). When that shrinks them past reading size, this zooms back to a
 * readable size around the focused step; people can still zoom out or pan
 * to see the rest.
 */
function ReadableFit({
  focusId,
  wholeRun,
  onFitted,
}: Readonly<{
  focusId: string | undefined;
  /** Keep the whole run in view instead of zooming to readable. */
  wholeRun: boolean;
  onFitted: () => void;
}>) {
  const flow = useReactFlow();
  const store = useStoreApi();
  const initialFitDone = useStore((state) => !state.fitViewQueued);
  const refine = useEffectEvent(async () => {
    const focus =
      focusId === undefined ? undefined : flow.getInternalNode(focusId);
    if (!wholeRun && flow.getZoom() < READABLE_ZOOM && focus !== undefined) {
      const { width, height } = store.getState();
      const bounds = flow.getNodesBounds(flow.getNodes());
      const { x, y } = focus.internals.positionAbsolute;
      await flow.setCenter(
        clampCentre(
          x + (focus.measured.width ?? 0) / 2,
          bounds.x,
          bounds.width,
          width / (2 * READABLE_ZOOM) - 24,
        ),
        clampCentre(
          y + (focus.measured.height ?? 0) / 2,
          bounds.y,
          bounds.height,
          height / (2 * READABLE_ZOOM) - 24,
        ),
        { zoom: READABLE_ZOOM },
      );
    }
    onFitted();
  });
  useEffect(() => {
    if (initialFitDone) void refine();
  }, [initialFitDone]);
  return null;
}

const edgeStrokeClass: Readonly<Partial<Record<StatusTone, string>>> = {
  live: '!stroke-primary',
  success: '!stroke-success/55',
  failure: '!stroke-destructive',
  timeout: '!stroke-destructive',
  attention: '!stroke-warning',
  waiting: '!stroke-secondary/70',
};

/**
 * The exact version this run executes, drawn on the weave with each step's
 * status. The running step carries the live edge; clicking a step opens it
 * in the step lens.
 */
export function RunGraphView({
  graph,
  rows,
  selectedNodeId,
  onSelectNode,
}: Readonly<{
  graph: WorkflowGraphContract;
  rows: readonly ThreadRow[];
  selectedNodeId: string | undefined;
  onSelectNode: (nodeId: string) => void;
}>) {
  const projection = useMemo(() => projectRunGraph(graph, rows), [graph, rows]);
  // Hidden until the first fit, so the map never jumps into place.
  const [fitted, setFitted] = useState(false);
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
  const nodes = useMemo<RunNode[]>(
    () =>
      projection.nodes.map((node) => ({
        id: node.id,
        type: 'runNode',
        position: node.position,
        data: { ...node, selected: node.id === selectedNodeId },
      })),
    [projection, selectedNodeId],
  );
  const edges = useMemo<RunEdge[]>(
    () =>
      projection.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        sourceHandle: edge.sourceHandle,
        target: edge.target,
        targetHandle: edge.targetHandle,
        type: 'runEdge',
        data: {
          tone: edge.tone,
          active: edge.active,
          skipped: edge.skipped,
          ...(edge.branch === undefined ? {} : { branch: edge.branch }),
        },
      })),
    [projection],
  );

  return (
    <div
      className="weave relative h-[30rem] overflow-hidden rounded-xl border border-white/6"
      aria-label="Map of the steps in this run's version"
    >
      <ReactFlow<RunNode, RunEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeClick={(_event, node) => {
          onSelectNode(node.id);
        }}
        colorMode="dark"
        fitView
        fitViewOptions={phone ? PHONE_FIT_OPTIONS : FIT_OPTIONS}
        minZoom={phone ? 0.2 : 0.35}
        maxZoom={1.6}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
        style={{ background: 'transparent' }}
        className={cn(
          'transition-opacity duration-150 motion-reduce:transition-none',
          !fitted && 'opacity-0',
        )}
      >
        <ReadableFit
          focusId={selectedNodeId ?? graph.nodes[0]?.id}
          wholeRun={phone}
          onFitted={() => {
            setFitted(true);
          }}
        />
        {/* Top right, clear of the phone's floating run actions. */}
        <Controls
          position="top-right"
          showInteractive={false}
          className="workflow-canvas-controls"
        />
      </ReactFlow>
    </div>
  );
}

function WorkflowRunNode({ data }: NodeProps<RunNode>) {
  return (
    <article
      className={cn(
        'relative w-56 cursor-pointer rounded-lg border bg-card shadow-[0_18px_44px_-18px_rgb(0_0_0/90%)] transition-shadow',
        toneBorderClass[data.tone],
        data.tone === 'live' && 'live-edge',
        data.selected && 'ring-2 ring-ring/60',
      )}
    >
      {data.inputs.map((port, index) => (
        <Handle
          key={port}
          id={port}
          type="target"
          position={Position.Left}
          style={{
            top: `${String(((index + 1) / (data.inputs.length + 1)) * 100)}%`,
          }}
          className="!size-2 !border-white/20 !bg-background"
        />
      ))}
      <div className="px-3 pt-2.5 pb-2">
        <p className="truncate text-sm font-semibold">{data.label}</p>
        {data.kind === data.label ? null : (
          <p className="mt-0.5 truncate text-xs text-subtle-foreground">
            {data.kind}
          </p>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-white/6 px-3 py-2">
        <Status tone={data.tone}>{data.statusLabel}</Status>
        {data.invocations > 1 ? (
          <span className="font-mono text-[0.7rem] text-subtle-foreground">
            ×{String(data.invocations)}
          </span>
        ) : null}
      </div>
      {data.outputs.map((port, index) => (
        <Handle
          key={port}
          id={port}
          type="source"
          position={Position.Right}
          style={{
            top: `${String(((index + 1) / (data.outputs.length + 1)) * 100)}%`,
          }}
          className="!size-2 !border-white/20 !bg-background"
        />
      ))}
    </article>
  );
}

function WorkflowRunEdge({
  data,
  markerEnd,
  sourcePosition,
  sourceX,
  sourceY,
  targetPosition,
  targetX,
  targetY,
}: EdgeProps<RunEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourcePosition,
    sourceX,
    sourceY,
    targetPosition,
    targetX,
    targetY,
  });
  const tone = data?.tone ?? 'neutral';
  const marker = markerEnd === undefined ? {} : { markerEnd };
  return (
    <>
      <BaseEdge
        path={path}
        {...marker}
        className="!stroke-white/8 !stroke-[3]"
      />
      <BaseEdge
        path={path}
        {...marker}
        className={cn(
          '!stroke-[1.5]',
          // A path the run didn't take is dashed and quiet.
          data?.skipped === true
            ? '![stroke-dasharray:4_5] !stroke-muted-foreground/30'
            : (edgeStrokeClass[tone] ?? '!stroke-muted-foreground/35'),
        )}
      />
      {data?.branch === undefined ? null : (
        <text
          x={labelX}
          y={labelY - 6}
          textAnchor="middle"
          className="fill-subtle-foreground font-mono text-[11px]"
        >
          {data.branch}
        </text>
      )}
      {data?.active === true ? (
        <circle
          r="2.5"
          className="workflow-transfer-marker fill-accent-foreground [filter:drop-shadow(0_0_5px_rgb(0_229_255/70%))] motion-reduce:hidden"
          aria-hidden="true"
        >
          <animate
            attributeName="opacity"
            dur="1.2s"
            values="0;1;1;0"
            repeatCount="indefinite"
          />
          <animateMotion dur="1.2s" path={path} repeatCount="indefinite" />
        </circle>
      ) : null}
    </>
  );
}
