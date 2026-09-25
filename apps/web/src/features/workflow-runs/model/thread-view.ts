import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import type {
  WorkflowNodeRunSummary,
  WorkflowRunEvent,
  WorkflowRunSummary,
} from '@pertexo/contracts/schemas/workflow-runs';
import type { StatusTone } from '@/components/ui/status';
import { describeStep } from '@/features/catalog/presentation.public';
import { formatDurationMs } from '@/lib/format-time';
import {
  describeNodeStatus,
  isActiveRunStatus,
  type NodeStatus,
} from './run-status';
import {
  replayFromSummary,
  replayStep,
  type StepOutput,
  type StepStoryEntry,
  type ThreadSegment,
} from './step-replay';

export type { ThreadSegment };

export type ThreadStepStatus = NodeStatus | 'not_started';

/** One step invocation laid out on the run's time axis. */
export type ThreadRow = Readonly<{
  key: string;
  nodeId: string;
  invocationKey?: string;
  nodeRunId?: string;
  label: string;
  /** What kind of step it is, when the graph names it separately. */
  kindLabel?: string;
  status: ThreadStepStatus;
  tone: StatusTone;
  statusLabel: string;
  attempts: number;
  segments: readonly ThreadSegment[];
  story: readonly StepStoryEntry[];
  outputs: readonly StepOutput[];
  safeErrorCode?: string;
  resumeAt?: string;
  startedAt?: string;
  completedAt?: string;
}>;

export type ThreadTick = Readonly<{ offsetMs: number; label: string }>;

export type ThreadView = Readonly<{
  startMs: number;
  endMs: number;
  rows: readonly ThreadRow[];
  ticks: readonly ThreadTick[];
}>;

type StepLabel = Readonly<{ label: string; kindLabel?: string }>;

const TICK_STEPS_MS = [
  100, 250, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000,
  300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000,
  43_200_000, 86_400_000,
];

type GraphLabel = Readonly<{ step: StepLabel; order: number }>;

function graphLabels(
  graph: WorkflowGraphContract | undefined,
): ReadonlyMap<string, GraphLabel> {
  const labels = new Map<string, GraphLabel>();
  graph?.nodes.forEach((node, order) => {
    // The catalog's name for the step type, the same words Build uses.
    const kind = describeStep(node.definition.key).name;
    const label = node.label?.trim();
    labels.set(node.id, {
      step:
        label === undefined || label === ''
          ? { label: kind }
          : { label, kindLabel: kind },
      order,
    });
  });
  return labels;
}

function eventKey(event: WorkflowRunEvent): string | undefined {
  if (!event.type.startsWith('node.')) return undefined;
  const { invocationKey, nodeId } = event.payload;
  if (invocationKey !== undefined) return invocationKey;
  return nodeId === undefined ? undefined : `node:${nodeId}`;
}

interface Invocation {
  key: string;
  nodeId: string;
  invocationKey?: string;
  summary?: WorkflowNodeRunSummary;
  events: WorkflowRunEvent[];
}

function collectInvocations(
  nodes: readonly WorkflowNodeRunSummary[],
  events: readonly WorkflowRunEvent[],
): Invocation[] {
  const invocations = new Map<string, Invocation>();
  const summariesByNode = new Map<string, WorkflowNodeRunSummary[]>();
  for (const summary of nodes) {
    invocations.set(summary.invocationKey, {
      key: summary.invocationKey,
      nodeId: summary.nodeId,
      invocationKey: summary.invocationKey,
      summary,
      events: [],
    });
    summariesByNode.set(summary.nodeId, [
      ...(summariesByNode.get(summary.nodeId) ?? []),
      summary,
    ]);
  }
  for (const event of events) {
    let key = eventKey(event);
    const nodeId = event.payload.nodeId;
    if (key === undefined) continue;
    // An event without an invocation key belongs to the node's only run.
    const only = nodeId === undefined ? undefined : summariesByNode.get(nodeId);
    if (key.startsWith('node:') && only?.length === 1 && only[0] !== undefined)
      key = only[0].invocationKey;
    const known = invocations.get(key);
    if (known !== undefined) known.events.push(event);
    else if (nodeId !== undefined)
      invocations.set(key, {
        key,
        nodeId,
        ...(event.payload.invocationKey === undefined
          ? {}
          : { invocationKey: event.payload.invocationKey }),
        events: [event],
      });
  }
  return [...invocations.values()];
}

function runBounds(run: WorkflowRunSummary, nowMs: number) {
  const startMs = Date.parse(run.startedAt ?? run.createdAt);
  const endMs = isActiveRunStatus(run.status)
    ? null
    : Date.parse(run.completedAt ?? run.updatedAt);
  return { startMs, endMs, axisEndMs: endMs ?? Math.max(nowMs, startMs) };
}

function threadTicks(durationMs: number): readonly ThreadTick[] {
  const step =
    TICK_STEPS_MS.find((candidate) => durationMs / candidate <= 6) ??
    durationMs;
  const ticks: ThreadTick[] = [];
  for (let offset = 0; offset <= durationMs; offset += step)
    ticks.push({
      offsetMs: offset,
      label: offset === 0 ? '0' : formatDurationMs(offset),
    });
  return ticks;
}

function rowFor(
  invocation: Invocation,
  label: StepLabel,
  bounds: ReturnType<typeof runBounds>,
): ThreadRow & { firstActivityMs: number } {
  const ordered = [...invocation.events].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const replay =
    ordered.length === 0 && invocation.summary !== undefined
      ? replayFromSummary(invocation.summary, bounds.startMs, bounds.endMs)
      : replayStep(ordered, invocation.summary, bounds.endMs);
  const status = replay.status ?? 'pending';
  const look = describeNodeStatus(status);
  const startedAt = invocation.summary?.startedAt ?? undefined;
  const completedAt = invocation.summary?.completedAt ?? undefined;
  return {
    key: invocation.key,
    nodeId: invocation.nodeId,
    ...(invocation.invocationKey === undefined
      ? {}
      : { invocationKey: invocation.invocationKey }),
    ...(replay.nodeRunId === undefined ? {} : { nodeRunId: replay.nodeRunId }),
    ...label,
    status,
    tone: look.tone,
    statusLabel: look.label,
    attempts: replay.attempts,
    segments: replay.segments,
    story: replay.story,
    outputs: replay.outputs,
    ...(replay.safeErrorCode === undefined
      ? {}
      : { safeErrorCode: replay.safeErrorCode }),
    ...(replay.resumeAt === undefined ? {} : { resumeAt: replay.resumeAt }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    firstActivityMs: replay.firstActivityMs ?? Number.POSITIVE_INFINITY,
  };
}

function notStartedRow(
  nodeId: string,
  label: StepLabel,
  bounds: ReturnType<typeof runBounds>,
): ThreadRow {
  return {
    key: `node:${nodeId}`,
    nodeId,
    ...label,
    status: 'not_started',
    tone: bounds.endMs === null ? 'queued' : 'skipped',
    statusLabel: bounds.endMs === null ? 'Not started yet' : 'Not reached',
    attempts: 0,
    segments:
      bounds.endMs === null
        ? [
            {
              kind: 'pending',
              tone: 'queued',
              startMs: bounds.startMs,
              endMs: null,
            },
          ]
        : [],
    story: [],
    outputs: [],
  };
}

/**
 * The Thread view: one row per step invocation in the order they started,
 * followed by steps of the version that haven't run (yet).
 */
export function buildThreadView(
  input: Readonly<{
    run: WorkflowRunSummary;
    nodes: readonly WorkflowNodeRunSummary[];
    events: readonly WorkflowRunEvent[];
    graph?: WorkflowGraphContract;
    nowMs: number;
  }>,
): ThreadView {
  const bounds = runBounds(input.run, input.nowMs);
  const labels = graphLabels(input.graph);
  const invocations = collectInvocations(input.nodes, input.events);
  const perNode = new Map<string, number>();
  const rows = invocations
    .map((invocation) => {
      const graphLabel = labels.get(invocation.nodeId);
      const index = (perNode.get(invocation.nodeId) ?? 0) + 1;
      perNode.set(invocation.nodeId, index);
      return {
        row: rowFor(
          invocation,
          graphLabel?.step ?? { label: invocation.nodeId },
          bounds,
        ),
        order: graphLabel?.order ?? Number.MAX_SAFE_INTEGER,
        index,
      };
    })
    .sort(
      (left, right) =>
        left.row.firstActivityMs - right.row.firstActivityMs ||
        left.order - right.order ||
        left.index - right.index,
    )
    .map(({ row, index }) => {
      const repeated = (perNode.get(row.nodeId) ?? 0) > 1;
      const { firstActivityMs: _first, ...rest } = row;
      void _first;
      return repeated
        ? { ...rest, label: `${rest.label} · ${String(index)}` }
        : rest;
    });
  const invoked = new Set(invocations.map((invocation) => invocation.nodeId));
  const pending = [...labels.entries()]
    .filter(([nodeId]) => !invoked.has(nodeId))
    .sort(([, left], [, right]) => left.order - right.order)
    .map(([nodeId, label]) => notStartedRow(nodeId, label.step, bounds));
  const allRows = [...rows, ...pending];
  let endMs = bounds.axisEndMs;
  for (const row of allRows)
    for (const segment of row.segments)
      if (segment.endMs !== null && segment.endMs > endMs)
        endMs = segment.endMs;
  endMs = Math.max(endMs, bounds.startMs + 1_000);
  return {
    startMs: bounds.startMs,
    endMs,
    rows: allRows,
    ticks: threadTicks(endMs - bounds.startMs),
  };
}

/** A segment's start and width as percentages of the axis. */
export function segmentPlacement(
  view: Pick<ThreadView, 'startMs' | 'endMs'>,
  segment: ThreadSegment,
  nowMs: number,
): Readonly<{ left: number; width: number }> {
  const span = view.endMs - view.startMs;
  const start = Math.min(Math.max(segment.startMs, view.startMs), view.endMs);
  const end = Math.min(
    Math.max(segment.endMs ?? Math.min(nowMs, view.endMs), start),
    view.endMs,
  );
  return {
    left: ((start - view.startMs) / span) * 100,
    width: ((end - start) / span) * 100,
  };
}
