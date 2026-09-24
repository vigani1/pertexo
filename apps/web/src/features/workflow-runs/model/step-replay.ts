import type {
  WorkflowNodeRunSummary,
  WorkflowRunEvent,
} from '@pertexo/contracts/schemas/workflow-runs';
import type { StatusTone } from '@/components/ui/status';
import { describeNodeStatus, type NodeStatus } from './run-status';

// Rebuilds one step invocation's story from its events: attempts become
// segments, failures fray, waits and scheduled retries coil. When events are
// missing (older than the retained window) the node summary fills in.

export type ThreadEnd = 'knot' | 'fray' | 'bar' | 'cut' | 'gap';

export type ThreadSegment = Readonly<{
  kind: 'attempt' | 'wait' | 'skipped' | 'pending';
  tone: StatusTone;
  startMs: number;
  /** Null while open: the segment grows to "now". */
  endMs: number | null;
  end?: ThreadEnd;
}>;

export type StepOutcome =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'canceled'
  | 'outcome_unknown'
  | 'scheduled'
  | 'waiting'
  | 'skipped';

export type StepStoryEntry = Readonly<{
  kind: 'attempt' | 'retry' | 'wait' | 'skipped';
  outcome: StepOutcome;
  tone: StatusTone;
  startedAt: string;
  attemptNumber?: number;
  endedAt?: string;
  dueAt?: string;
  safeErrorCode?: string;
}>;

export type StepOutput =
  | Readonly<{ kind: 'artifact'; artifactId: string; attemptNumber?: number }>
  | Readonly<{ kind: 'inline'; attemptId: string; attemptNumber?: number }>;

export type StepReplay = Readonly<{
  segments: readonly ThreadSegment[];
  story: readonly StepStoryEntry[];
  outputs: readonly StepOutput[];
  attempts: number;
  status?: NodeStatus;
  safeErrorCode?: string;
  resumeAt?: string;
  nodeRunId?: string;
  firstActivityMs?: number;
}>;

type Finish = Readonly<{
  outcome: StepOutcome;
  status: NodeStatus;
  tone: StatusTone;
  end: ThreadEnd;
}>;

const succeededFinish: Finish = {
  outcome: 'succeeded',
  status: 'succeeded',
  tone: 'success',
  end: 'knot',
};
const failedFinish: Finish = {
  outcome: 'failed',
  status: 'failed',
  tone: 'failure',
  end: 'fray',
};
const timedOutFinish: Finish = {
  outcome: 'timed_out',
  status: 'timed_out',
  tone: 'timeout',
  end: 'bar',
};
const canceledFinish: Finish = {
  outcome: 'canceled',
  status: 'canceled',
  tone: 'canceled',
  end: 'cut',
};
const unknownFinish: Finish = {
  outcome: 'outcome_unknown',
  status: 'outcome_unknown',
  tone: 'attention',
  end: 'gap',
};

const finishes: Partial<Record<WorkflowRunEvent['type'], Finish>> = {
  'node.succeeded': succeededFinish,
  'node.failed': failedFinish,
  'node.timed_out': timedOutFinish,
  'node.canceled': canceledFinish,
  'node.outcome_unknown': unknownFinish,
};

const statusFinishes: Partial<Record<NodeStatus, Finish>> = {
  succeeded: succeededFinish,
  failed: failedFinish,
  timed_out: timedOutFinish,
  canceled: canceledFinish,
  outcome_unknown: unknownFinish,
};

function openTone(kind: OpenSpan['kind'], attemptTone: StatusTone): StatusTone {
  if (kind === 'attempt') return attemptTone;
  return kind === 'wait' ? 'waiting' : 'queued';
}

interface OpenSpan {
  kind: 'attempt' | 'wait' | 'pending';
  startMs: number;
  dueAt?: string;
}

class StepReplayBuilder {
  public readonly segments: ThreadSegment[] = [];
  public readonly story: StepStoryEntry[] = [];
  public readonly outputs: StepOutput[] = [];
  public open: OpenSpan | undefined;
  public attempts = 0;
  public status: NodeStatus | undefined;
  public safeErrorCode: string | undefined;
  public nodeRunId: string | undefined;
  public firstActivityMs: number | undefined;

  public apply(event: WorkflowRunEvent): void {
    const atMs = Date.parse(event.createdAt);
    const payload = event.payload;
    this.firstActivityMs ??= atMs;
    this.nodeRunId ??= payload.nodeRunId;
    const finish = finishes[event.type];
    if (finish !== undefined) {
      this.finish(finish, event.createdAt, payload.safeErrorCode);
      this.addOutput(payload.outputRef, payload.attemptNumber);
      return;
    }
    switch (event.type) {
      case 'node.ready':
        this.status = 'ready';
        this.open ??= { kind: 'pending', startMs: atMs };
        return;
      case 'node.started':
        this.start(event.createdAt, payload.attemptNumber);
        return;
      case 'node.retry_scheduled':
        this.scheduleRetry(event.createdAt, payload);
        return;
      case 'node.waiting':
        this.wait(event.createdAt, payload.dueAt);
        return;
      case 'node.skipped':
        this.skip(event.createdAt);
        return;
      default:
        return;
    }
  }

  private close(atMs: number, tone: StatusTone, end?: ThreadEnd): void {
    const open = this.open;
    if (open === undefined) return;
    this.segments.push({
      kind: open.kind,
      tone: openTone(open.kind, tone),
      startMs: open.startMs,
      endMs: atMs,
      ...(end === undefined ? {} : { end }),
    });
    this.open = undefined;
  }

  private updateLast(
    kinds: readonly StepStoryEntry['kind'][],
    update: Partial<StepStoryEntry>,
  ): boolean {
    const wanted = new Set(kinds);
    for (let index = this.story.length - 1; index >= 0; index -= 1) {
      const entry = this.story[index];
      if (entry === undefined || !wanted.has(entry.kind)) continue;
      if (entry.endedAt !== undefined) return false;
      this.story[index] = { ...entry, ...update };
      return true;
    }
    return false;
  }

  private start(createdAt: string, attemptNumber: number | undefined): void {
    const atMs = Date.parse(createdAt);
    this.close(atMs, 'live');
    this.updateLast(['retry', 'wait'], { endedAt: createdAt });
    const attempt = attemptNumber ?? this.attempts + 1;
    this.attempts = Math.max(this.attempts, attempt);
    this.status = 'running';
    this.open = { kind: 'attempt', startMs: atMs };
    this.story.push({
      kind: 'attempt',
      outcome: 'running',
      tone: 'live',
      startedAt: createdAt,
      attemptNumber: attempt,
    });
  }

  public finish(
    finish: Finish,
    createdAt: string,
    safeErrorCode: string | undefined,
  ): void {
    this.close(Date.parse(createdAt), finish.tone, finish.end);
    this.status = finish.status;
    if (safeErrorCode !== undefined) this.safeErrorCode = safeErrorCode;
    const update = {
      outcome: finish.outcome,
      tone: finish.tone,
      endedAt: createdAt,
      ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
    };
    if (this.updateLast(['attempt'], update)) {
      this.updateLast(['wait'], { endedAt: createdAt });
      return;
    }
    this.updateLast(['wait', 'retry'], { endedAt: createdAt });
    this.story.push({ kind: 'attempt', startedAt: createdAt, ...update });
  }

  private scheduleRetry(
    createdAt: string,
    payload: WorkflowRunEvent['payload'],
  ): void {
    if (this.open?.kind === 'attempt')
      this.finish(failedFinish, createdAt, payload.safeErrorCode);
    else this.close(Date.parse(createdAt), 'failure');
    this.status = 'waiting';
    this.open = {
      kind: 'wait',
      startMs: Date.parse(createdAt),
      ...(payload.dueAt === undefined ? {} : { dueAt: payload.dueAt }),
    };
    this.story.push({
      kind: 'retry',
      outcome: 'scheduled',
      tone: 'waiting',
      startedAt: createdAt,
      ...(payload.attemptNumber === undefined
        ? {}
        : { attemptNumber: payload.attemptNumber }),
      ...(payload.dueAt === undefined ? {} : { dueAt: payload.dueAt }),
    });
  }

  private wait(createdAt: string, dueAt: string | undefined): void {
    this.close(Date.parse(createdAt), 'live');
    this.updateLast(['attempt'], { outcome: 'waiting', tone: 'waiting' });
    this.status = 'waiting';
    this.open = {
      kind: 'wait',
      startMs: Date.parse(createdAt),
      ...(dueAt === undefined ? {} : { dueAt }),
    };
    this.story.push({
      kind: 'wait',
      outcome: 'waiting',
      tone: 'waiting',
      startedAt: createdAt,
      ...(dueAt === undefined ? {} : { dueAt }),
    });
  }

  private skip(createdAt: string): void {
    const atMs = Date.parse(createdAt);
    const startMs = this.open?.startMs ?? atMs;
    this.open = undefined;
    this.status = 'skipped';
    this.segments.push({
      kind: 'skipped',
      tone: 'skipped',
      startMs,
      endMs: atMs,
    });
    this.story.push({
      kind: 'skipped',
      outcome: 'skipped',
      tone: 'skipped',
      startedAt: createdAt,
      endedAt: createdAt,
    });
  }

  private addOutput(
    outputRef: WorkflowRunEvent['payload']['outputRef'],
    attemptNumber: number | undefined,
  ): void {
    if (outputRef === undefined) return;
    const attempt = attemptNumber === undefined ? {} : { attemptNumber };
    this.outputs.push(
      outputRef.kind === 'artifact'
        ? { kind: 'artifact', artifactId: outputRef.artifactId, ...attempt }
        : { kind: 'inline', attemptId: outputRef.attemptId, ...attempt },
    );
  }

  /** Closes whatever is still open using the node summary, if it's final. */
  public settle(
    summary: WorkflowNodeRunSummary | undefined,
    runEndMs: number | null,
  ): void {
    const finish =
      summary === undefined ? undefined : statusFinishes[summary.status];
    if (
      this.open !== undefined &&
      finish !== undefined &&
      summary !== undefined
    )
      this.finish(
        finish,
        summary.completedAt ??
          summary.startedAt ??
          new Date(this.open.startMs).toISOString(),
        summary.safeErrorCode ?? undefined,
      );
    const open = this.open;
    if (open === undefined) return;
    if (runEndMs !== null) {
      this.close(runEndMs, 'canceled', 'cut');
      return;
    }
    const dueMs = open.dueAt === undefined ? null : Date.parse(open.dueAt);
    this.segments.push({
      kind: open.kind,
      tone: openTone(open.kind, 'live'),
      startMs: open.startMs,
      endMs: open.kind === 'wait' ? dueMs : null,
    });
  }
}

/** Replays one invocation's node events (already in sequence order). */
export function replayStep(
  events: readonly WorkflowRunEvent[],
  summary: WorkflowNodeRunSummary | undefined,
  runEndMs: number | null,
): StepReplay {
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
    attempts: Math.max(builder.attempts, summary?.currentAttemptNumber ?? 0),
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
): ThreadSegment {
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
