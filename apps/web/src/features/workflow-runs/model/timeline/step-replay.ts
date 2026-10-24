import type {
  WorkflowNodeRunSummary,
  WorkflowRunEvent,
} from '@pertexo/contracts';
import type { StatusTone } from '@/components/ui/status';
import {
  describeNodeStatus,
  type NodeStatus,
} from '../presentation/run-status';
import type { StepOutcome, StepReplay, RunTimelineSegment } from './step-story';
import { statusFinishes } from './replay-builder';
import { StepReplayBuilder } from './replay-builder';

// Rebuilds one step invocation's story from its events: attempts become
// segments, failures fray, waits and scheduled retries coil. When events are
// missing (older than the retained window) the node summary fills in.

export type {
  StepOutput,
  StepStoryEntry,
  RunTimelineSegment,
} from './step-story';

/** Replays one invocation's node events (already in sequence order). */
export function replayStep(
  events: readonly WorkflowRunEvent[],
  summary: WorkflowNodeRunSummary | undefined,
  runEndMs: number | null,
): StepReplay {
  if (summary?.reused !== undefined)
    return {
      segments: [],
      story: [],
      outputs: [],
      attempts: 0,
      status: summary.status,
      nodeRunId: summary.id,
    };
  const builder = new StepReplayBuilder();
  for (const event of events) builder.apply(event);
  const openDueAt = builder.open?.dueAt;
  builder.settle(summary, runEndMs);
  const status = summary?.status ?? builder.status;
  const safeErrorCode = summary?.safeErrorCode ?? builder.safeErrorCode;
  const resumeAt = summary?.resumeAt ?? openDueAt;
  const nodeRunId = summary?.id ?? builder.nodeRunId;
  return {
    segments: builder.segments,
    story: builder.story,
    outputs: builder.outputs,
    attempts: Math.max(
      builder.attempts,
      (summary?.currentAttemptNumber ?? 0) - builder.resumes,
    ),
    ...(status === undefined ? {} : { status }),
    ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
    ...(resumeAt === undefined ? {} : { resumeAt }),
    ...(nodeRunId === undefined ? {} : { nodeRunId }),
    ...(builder.firstActivityMs === undefined
      ? {}
      : { firstActivityMs: builder.firstActivityMs }),
  };
}

/** A best-effort story from the node summary alone, when no events remain. */
export function replayFromSummary(
  summary: WorkflowNodeRunSummary,
  runStartMs: number,
  runEndMs: number | null,
): StepReplay {
  if (summary.reused !== undefined) return replayStep([], summary, runEndMs);
  const { tone } = describeNodeStatus(summary.status);
  const startMs =
    summary.startedAt === null ? runStartMs : Date.parse(summary.startedAt);
  const endMs =
    summary.completedAt === null ? null : Date.parse(summary.completedAt);
  const segment = summarySegment(summary, startMs, endMs ?? runEndMs, tone);
  const finish = statusFinishes[summary.status];
  const startedAt = summary.startedAt ?? new Date(runStartMs).toISOString();
  return {
    segments: [segment],
    story:
      summary.startedAt === null && summary.status !== 'skipped'
        ? []
        : [
            {
              id:
                summary.status === 'skipped'
                  ? 'summary:skipped'
                  : 'summary:attempt',
              kind: summary.status === 'skipped' ? 'skipped' : 'attempt',
              outcome: finish?.outcome ?? openOutcome(summary.status),
              tone,
              startedAt,
              ...(summary.currentAttemptNumber > 0
                ? { attemptNumber: summary.currentAttemptNumber }
                : {}),
              ...(summary.completedAt === null
                ? {}
                : { endedAt: summary.completedAt }),
              ...(summary.safeErrorCode === null
                ? {}
                : { safeErrorCode: summary.safeErrorCode }),
            },
          ],
    outputs: [],
    attempts: summary.currentAttemptNumber,
    status: summary.status,
    ...(summary.safeErrorCode === null
      ? {}
      : { safeErrorCode: summary.safeErrorCode }),
    ...(summary.resumeAt === null ? {} : { resumeAt: summary.resumeAt }),
    nodeRunId: summary.id,
    ...(summary.startedAt === null ? {} : { firstActivityMs: startMs }),
  };
}

function openOutcome(status: NodeStatus): StepOutcome {
  if (status === 'waiting' || status === 'skipped') return status;
  return 'running';
}

function summarySegment(
  summary: WorkflowNodeRunSummary,
  startMs: number,
  endMs: number | null,
  tone: StatusTone,
): RunTimelineSegment {
  switch (summary.status) {
    case 'pending':
    case 'ready':
      return { kind: 'pending', tone: 'queued', startMs, endMs: null };
    case 'skipped':
      return { kind: 'skipped', tone, startMs, endMs: endMs ?? startMs };
    case 'waiting':
      return {
        kind: 'wait',
        tone,
        startMs,
        endMs: summary.resumeAt === null ? null : Date.parse(summary.resumeAt),
      };
    case 'running':
      return { kind: 'attempt', tone, startMs, endMs: null };
    case 'canceled':
    case 'failed':
    case 'outcome_unknown':
    case 'succeeded':
    case 'timed_out':
    default: {
      const end = statusFinishes[summary.status]?.end;
      return {
        kind: 'attempt',
        tone,
        startMs,
        endMs: endMs ?? startMs,
        ...(end === undefined ? {} : { end }),
      };
    }
  }
}
