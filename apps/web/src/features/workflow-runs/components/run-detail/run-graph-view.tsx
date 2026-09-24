import '@xyflow/react/dist/style.css';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import {
  BaseEdge,
  Controls,
  Handle,
  Position,
  ReactFlow,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useMemo } from 'react';
import { Status, type StatusTone } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import { projectRunGraph, type GraphStepStatus } from '../../model/run-graph';
import type { ThreadRow } from '../../model/thread-view';
import { toneBorderClass } from '../tone-styles';

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
}

type RunNode = Node<RunNodeData, 'runNode'>;
type RunEdge = Edge<RunEdgeData, 'runEdge'>;

const nodeTypes = Object.freeze({ runNode: WorkflowRunNode });
const edgeTypes = Object.freeze({ runEdge: WorkflowRunEdge });

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
        data: { tone: edge.tone, active: edge.active },
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
        fitViewOptions={{ padding: 0.24 }}
        minZoom={0.35}
        maxZoom={1.6}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
        style={{ background: 'transparent' }}
      >
        <Controls
          position="bottom-right"
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
        <p className="mt-0.5 truncate text-xs text-subtle-foreground">
          {data.kind}
        </p>
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
  const [path] = getSmoothStepPath({
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
          edgeStrokeClass[tone] ?? '!stroke-muted-foreground/35',
        )}
      />
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
