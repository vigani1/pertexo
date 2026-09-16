import '@xyflow/react/dist/style.css';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import type {
  WorkflowNodeRunSummary,
  WorkflowRunSummary,
} from '@pertexo/contracts/schemas/workflow-runs';
import {
  BaseEdge,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { WorkflowRunLoadingWave } from './workflow-run-loading-wave';
import { isTerminalRunStatus } from '../model/run-events';

type NodeStatus = WorkflowNodeRunSummary['status'] | 'not_started';

interface RunNodeData extends Record<string, unknown> {
  label: string;
  definition: string;
  status: NodeStatus;
  invocationCount: number;
  inputs: readonly string[];
  outputs: readonly string[];
}

interface RunEdgeData extends Record<string, unknown> {
  status: NodeStatus;
}

type RunNode = Node<RunNodeData, 'runNode'>;
type RunEdge = Edge<RunEdgeData, 'runEdge'>;

const nodeTypes = Object.freeze({ runNode: WorkflowRunNode });
const edgeTypes = Object.freeze({ runEdge: WorkflowRunEdge });
const activeStatuses = new Set<NodeStatus>(['ready', 'running', 'waiting']);
const completedStatuses = new Set<NodeStatus>(['succeeded']);
const failedStatuses = new Set<NodeStatus>([
  'failed',
  'timed_out',
  'outcome_unknown',
]);
const statusPriority: Readonly<Record<NodeStatus, number>> = {
  not_started: 0,
  pending: 1,
  skipped: 2,
  succeeded: 3,
  canceled: 4,
  timed_out: 5,
  failed: 6,
  outcome_unknown: 7,
  ready: 8,
  waiting: 9,
  running: 10,
};

export function WorkflowRunGraph({
  graph,
  run,
  nodeRuns,
}: Readonly<{
  graph: WorkflowGraphContract;
  run: WorkflowRunSummary;
  nodeRuns: readonly WorkflowNodeRunSummary[];
}>) {
  const projection = useMemo(
    () => projectRunGraph(graph, nodeRuns),
    [graph, nodeRuns],
  );
  const showLoadingWave =
    !isTerminalRunStatus(run.status) && nodeRuns.length === 0;

  return (
    <section className="glass-panel overflow-hidden rounded-xl">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4 sm:px-6">
        <div>
          <h2 className="font-heading text-xl font-semibold">Execution map</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Live status for the exact workflow version accepted by this run.
          </p>
        </div>
        <span className="text-sm text-muted-foreground">
          {String(graph.nodes.length)} nodes · {String(graph.edges.length)}{' '}
          edges
        </span>
      </div>
      <div
        className="relative h-[28rem] bg-background/70"
        aria-label="Workflow execution map"
      >
        {showLoadingWave ? <WorkflowRunLoadingWave /> : null}
        <ReactFlow<RunNode, RunEdge>
          nodes={projection.nodes}
          edges={projection.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          colorMode="dark"
          fitView
          fitViewOptions={{ padding: 0.24 }}
          minZoom={0.35}
          maxZoom={1.6}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={1} color="rgba(185, 214, 219, 0.12)" />
          <MiniMap pannable zoomable position="bottom-left" />
          <Controls position="bottom-right" showInteractive={false} />
        </ReactFlow>
      </div>
    </section>
  );
}

function WorkflowRunNode({ data }: NodeProps<RunNode>) {
  const active = activeStatuses.has(data.status);
  const failed = failedStatuses.has(data.status);
  return (
    <article
      className={cn(
        'relative w-56 rounded-lg border bg-card/95 shadow-lg backdrop-blur-sm',
        active && 'border-primary/55 shadow-glow-primary-strong',
        failed && 'border-destructive/60',
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
          className="!size-2.5 !border-primary/60 !bg-background"
        />
      ))}
      <div className="border-b border-border px-3 py-2.5">
        <p className="truncate font-medium">{data.label}</p>
        <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
          {data.definition}
        </p>
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <Badge
          variant={failed ? 'destructive' : active ? 'secondary' : 'muted'}
        >
          {data.status.replaceAll('_', ' ')}
        </Badge>
        {data.invocationCount > 1 ? (
          <span className="text-xs text-muted-foreground">
            {String(data.invocationCount)} invocations
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
          className="!size-2.5 !border-primary/60 !bg-background"
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
  const status = data?.status ?? 'not_started';
  const active = activeStatuses.has(status);
  const completed = completedStatuses.has(status);
  const failed = failedStatuses.has(status);
  return (
    <>
      <BaseEdge
        path={path}
        {...(markerEnd === undefined ? {} : { markerEnd })}
        className="!stroke-border !stroke-[3]"
      />
      <BaseEdge
        path={path}
        {...(markerEnd === undefined ? {} : { markerEnd })}
        className={cn(
          '!stroke-[1.5]',
          failed
            ? '!stroke-destructive'
            : active
              ? '!stroke-primary'
              : completed
                ? '!stroke-primary/45'
                : '!stroke-muted-foreground/45',
        )}
      />
      {active ? (
        <circle
          r="2.5"
          className="workflow-transfer-marker fill-primary [filter:drop-shadow(0_0_5px_rgb(0_229_255/70%))] motion-reduce:hidden"
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

function projectRunGraph(
  graph: WorkflowGraphContract,
  nodeRuns: readonly WorkflowNodeRunSummary[],
): Readonly<{ nodes: RunNode[]; edges: RunEdge[] }> {
  const runsByNode = new Map<string, WorkflowNodeRunSummary[]>();
  for (const nodeRun of nodeRuns) {
    const current = runsByNode.get(nodeRun.nodeId);
    if (current === undefined) runsByNode.set(nodeRun.nodeId, [nodeRun]);
    else current.push(nodeRun);
  }
  const statusByNode = new Map<string, NodeStatus>();
  const portsByNode = new Map<
    string,
    { inputs: Set<string>; outputs: Set<string> }
  >();
  for (const edge of graph.edges) {
    const source = portsByNode.get(edge.source.nodeId) ?? {
      inputs: new Set<string>(),
      outputs: new Set<string>(),
    };
    source.outputs.add(edge.source.port);
    portsByNode.set(edge.source.nodeId, source);
    const target = portsByNode.get(edge.target.nodeId) ?? {
      inputs: new Set<string>(),
      outputs: new Set<string>(),
    };
    target.inputs.add(edge.target.port);
    portsByNode.set(edge.target.nodeId, target);
  }

  const nodes = graph.nodes.map((node) => {
    const invocations = runsByNode.get(node.id) ?? [];
    const status = aggregateNodeStatus(invocations);
    statusByNode.set(node.id, status);
    const ports = portsByNode.get(node.id);
    return {
      id: node.id,
      type: 'runNode',
      position: node.position,
      data: {
        label: node.label ?? node.definition.key,
        definition: `${node.definition.key}@${String(node.definition.version)}`,
        status,
        invocationCount: invocations.length,
        inputs: ports === undefined ? [] : [...ports.inputs],
        outputs: ports === undefined ? [] : [...ports.outputs],
      },
    } satisfies RunNode;
  });
  const edges = graph.edges.map(
    (edge) =>
      ({
        id: edge.id,
        source: edge.source.nodeId,
        sourceHandle: edge.source.port,
        target: edge.target.nodeId,
        targetHandle: edge.target.port,
        type: 'runEdge',
        data: { status: statusByNode.get(edge.target.nodeId) ?? 'not_started' },
      }) satisfies RunEdge,
  );
  return { nodes, edges };
}

function aggregateNodeStatus(
  nodeRuns: readonly WorkflowNodeRunSummary[],
): NodeStatus {
  let status: NodeStatus = 'not_started';
  for (const nodeRun of nodeRuns) {
    if (statusPriority[nodeRun.status] > statusPriority[status])
      status = nodeRun.status;
  }
  return status;
}
