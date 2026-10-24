import type {
  WorkflowGraphContract,
  WorkflowNodeReuse,
  WorkflowNodeRunSummary,
  WorkflowRunEvent,
  WorkflowRunSummary,
} from '@pertexo/contracts';
import type { StatusTone } from '@/components/ui/status';
import { describeStep } from '@/features/catalog/presentation.public';
import {
  describeNodeStatus,
  type NodeStatus,
} from '../presentation/run-status';
import {
  replayFromSummary,
  replayStep,
  type StepOutput,
  type StepStoryEntry,
  type RunTimelineSegment,
} from './step-replay';
import type { RunTimelineTick } from './geometry';
import { runBounds } from './geometry';
import { timelineTicks } from './geometry';

export type { RunTimelineSegment };

export type RunTimelineStepStatus = NodeStatus | 'not_started';

/** One step invocation laid out on the run's time axis. */
export type RunTimelineRow = Readonly<{
  key: string;
  nodeId: string;
  invocationKey?: string;
  nodeRunId?: string;
  label: string;
  /** What kind of step it is, when the graph names it separately. */
  kindLabel?: string;
  definitionKey?: string;
  /** The step sends its input through a connection, so it isn't kept. */
  usesConnection?: boolean;
  status: RunTimelineStepStatus;
  tone: StatusTone;
  statusLabel: string;
  attempts: number;
  reused?: WorkflowNodeReuse;
  failureHandling?: NonNullable<WorkflowNodeRunSummary['failureHandling']>;
  handlingInProgress?: true;
  /**
   * The node run's current attempt as the run snapshot has it, counting wait
   * resumes: data recorded per attempt is read again when it changes.
   */
  currentAttemptNumber?: number;
  segments: readonly RunTimelineSegment[];
  story: readonly StepStoryEntry[];
  outputs: readonly StepOutput[];
  safeErrorCode?: string;
  errorSummary?: string;
  resumeAt?: string;
  startedAt?: string;
  completedAt?: string;
}>;

export type RunTimelineModel = Readonly<{
  startMs: number;
  endMs: number;
  rows: readonly RunTimelineRow[];
  ticks: readonly RunTimelineTick[];
}>;

type StepLabel = Readonly<{
  label: string;
  kindLabel?: string;
  definitionKey?: string;
  usesConnection?: boolean;
}>;

type GraphLabel = Readonly<{
  step: StepLabel;
  order: number;
  root: boolean;
}>;

function graphLabels(
  graph: WorkflowGraphContract | undefined,
): ReadonlyMap<string, GraphLabel> {
  const labels = new Map<string, GraphLabel>();
  let order = 0;
  const visit = ({
    current,
    root,
  }: Readonly<{ current: WorkflowGraphContract; root: boolean }>) => {
    for (const node of current.nodes) {
      // The catalog's name for the step type, the same words Build uses.
      const kind = describeStep(node.definition.key).name;
      const label = node.label?.trim();
      const connected = {
        definitionKey: node.definition.key,
        ...(Object.keys(node.connectionRefs).length > 0
          ? { usesConnection: true }
          : {}),
      };
      labels.set(node.id, {
        step:
          label === undefined || label === ''
            ? { label: kind, ...connected }
            : { label, kindLabel: kind, ...connected },
        order: order++,
        root,
      });
      if (node.structured?.kind === 'for_each')
        visit({ current: node.structured.body, root: false });
    }
  };
  if (graph !== undefined) visit({ current: graph, root: true });
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

function rowFor(
  invocation: Invocation,
  label: StepLabel,
  bounds: ReturnType<typeof runBounds>,
): RunTimelineRow & { firstActivityMs: number } {
  const ordered = [...invocation.events].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const replay =
    ordered.length === 0 && invocation.summary !== undefined
      ? replayFromSummary(invocation.summary, bounds.startMs, bounds.endMs)
      : replayStep(ordered, invocation.summary, bounds.endMs);
  const status = replay.status ?? 'pending';
  const look = describeNodeStatus(status);
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
    statusLabel: rowStatusLabel(invocation.summary, look.label, bounds.endMs),
    ...summaryFields(invocation.summary, bounds.endMs),
    attempts: replay.attempts,
    segments: replay.segments,
    story: replay.story,
    outputs: replay.outputs,
    ...(replay.safeErrorCode === undefined
      ? {}
      : { safeErrorCode: replay.safeErrorCode }),
    ...(replay.resumeAt === undefined ? {} : { resumeAt: replay.resumeAt }),
    firstActivityMs: replay.firstActivityMs ?? Number.POSITIVE_INFINITY,
  };
}

function rowStatusLabel(
  summary: WorkflowNodeRunSummary | undefined,
  label: string,
  endMs: number | null,
): string {
  if (summary?.reused !== undefined) return 'Reused';
  if (summary?.failureHandling === undefined) return label;
  if (summary.failureHandling.disposition === 'handled')
    return 'Failed · failure handled';
  return endMs === null ? 'Failed · handling failure…' : 'Failed · not handled';
}

function summaryFields(
  summary: WorkflowNodeRunSummary | undefined,
  endMs: number | null,
) {
  if (summary === undefined) return {};
  const startedAt = summary.startedAt ?? undefined;
  const completedAt = summary.completedAt ?? undefined;
  return {
    ...(summary.failureHandling?.disposition === 'pending' && endMs === null
      ? { handlingInProgress: true as const }
      : {}),
    ...(summary.failureHandling === undefined
      ? {}
      : { failureHandling: summary.failureHandling }),
    ...(summary.reused === undefined ? {} : { reused: summary.reused }),
    ...(summary.errorSummary == null
      ? {}
      : { errorSummary: summary.errorSummary }),
    currentAttemptNumber: summary.currentAttemptNumber,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function notStartedRow(
  nodeId: string,
  label: StepLabel,
  bounds: ReturnType<typeof runBounds>,
): RunTimelineRow {
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
 * "item 3", or "item 2 › 3" in a loop inside a loop: the loop items a step
 * ran for. The engine keys a step run `…|i:<loop>:<ordinal>/…` with ordinals
 * from 0; anything else reads as no item.
 */
export function loopItemOf(
  invocationKey: string | undefined,
): string | undefined {
  const encoded = invocationKey?.split('|i:')[1];
  if (encoded === undefined || encoded === '') return undefined;
  let path: string;
  try {
    path = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
  const ordinals = path
    .split('/')
    .map((part) => Number(part.split(':').at(-1)));
  if (ordinals.some((ordinal) => !Number.isSafeInteger(ordinal) || ordinal < 0))
    return undefined;
  return `item ${ordinals.map((ordinal) => String(ordinal + 1)).join(' › ')}`;
}

/**
 * The Thread view: one row per step invocation in the order they started,
 * followed by steps of the version that haven't run (yet).
 */
export function buildRunTimeline(
  input: Readonly<{
    run: WorkflowRunSummary;
    nodes: readonly WorkflowNodeRunSummary[];
    events: readonly WorkflowRunEvent[];
    graph?: WorkflowGraphContract;
    nowMs: number;
  }>,
): RunTimelineModel {
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
      if (!repeated) return rest;
      const item = loopItemOf(rest.invocationKey);
      return {
        ...rest,
        label: `${rest.label} · ${item ?? String(index)}`,
      };
    });
  const invoked = new Set(invocations.map((invocation) => invocation.nodeId));
  const pending = [...labels.entries()]
    .filter(([nodeId, label]) => label.root && !invoked.has(nodeId))
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
    ticks: timelineTicks(endMs - bounds.startMs),
  };
}
