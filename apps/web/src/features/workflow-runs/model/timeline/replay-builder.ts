import type {
  WorkflowNodeRunSummary,
  WorkflowRunEvent,
} from '@pertexo/contracts';
import type { StatusTone } from '@/components/ui/status';
import type { NodeStatus } from '../presentation/run-status';
import type {
  StepOutcome,
  StepOutput,
  StepStoryEntry,
  RunTimelineEnd,
  RunTimelineSegment,
} from './step-story';

type Finish = Readonly<{
  outcome: StepOutcome;
  status: NodeStatus;
  tone: StatusTone;
  end: RunTimelineEnd;
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

export const statusFinishes: Partial<Record<NodeStatus, Finish>> = {
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

export class StepReplayBuilder {
  public readonly segments: RunTimelineSegment[] = [];
  public readonly story: StepStoryEntry[] = [];
  /** The event being applied, which names the entries it makes. */
  #source = 'summary';
  public readonly outputs: StepOutput[] = [];
  public open: OpenSpan | undefined;
  public attempts = 0;
  public status: NodeStatus | undefined;
  public safeErrorCode: string | undefined;
  public nodeRunId: string | undefined;
  public firstActivityMs: number | undefined;
  /** A Wait step is paused; its next start resumes the same attempt. */
  private resuming = false;
  /** Starts that resumed a wait, which the engine numbers as attempts. */
  public resumes = 0;

  /** A new entry in the story: one event makes at most one of each kind. */
  private tell(entry: Omit<StepStoryEntry, 'id'>): void {
    this.story.push({ id: `${this.#source}:${entry.kind}`, ...entry });
  }

  public apply(event: WorkflowRunEvent): void {
    this.#source = `event-${String(event.sequence)}`;
    const atMs = Date.parse(event.createdAt);
    const payload = event.payload;
    this.firstActivityMs ??= atMs;
    this.nodeRunId ??= payload.nodeRunId;
    const finish = finishes[event.type];
    if (finish !== undefined) {
      this.finish(finish, event.createdAt, payload);
      this.addOutput(payload.outputRef, payload.attemptNumber);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- Finishes use the table above; other event types do not change step replay.
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
        this.skip(event.createdAt, payload.reasonCode);
        return;
      default:
        return;
    }
  }

  private close(atMs: number, tone: StatusTone, end?: RunTimelineEnd): void {
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
    if (this.resuming) {
      // The engine starts a Wait step again when its time comes. That's the
      // same attempt carrying on, not a retry: one attempt, spanning the wait.
      this.resuming = false;
      this.resumes += 1;
      this.status = 'running';
      this.open = { kind: 'attempt', startMs: atMs };
      this.updateLast(['attempt'], { outcome: 'running', tone: 'live' });
      return;
    }
    const attempt = attemptNumber ?? this.attempts + 1;
    this.attempts = Math.max(this.attempts, attempt);
    this.status = 'running';
    this.open = { kind: 'attempt', startMs: atMs };
    this.tell({
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
    {
      safeErrorCode,
      reasonCode,
    }: Readonly<{
      safeErrorCode?: string | undefined;
      reasonCode?: string | undefined;
    }> = {},
  ): void {
    this.close(Date.parse(createdAt), finish.tone, finish.end);
    this.status = finish.status;
    if (safeErrorCode !== undefined) this.safeErrorCode = safeErrorCode;
    const update = {
      outcome: finish.outcome,
      tone: finish.tone,
      endedAt: createdAt,
      ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
      ...(reasonCode === undefined ? {} : { reasonCode }),
    };
    if (this.updateLast(['attempt'], update)) {
      this.updateLast(['wait'], { endedAt: createdAt });
      return;
    }
    this.updateLast(['wait', 'retry'], { endedAt: createdAt });
    this.tell({ kind: 'attempt', startedAt: createdAt, ...update });
  }

  private scheduleRetry(
    createdAt: string,
    payload: WorkflowRunEvent['payload'],
  ): void {
    if (this.open?.kind === 'attempt')
      this.finish(failedFinish, createdAt, payload);
    else this.close(Date.parse(createdAt), 'failure');
    this.resuming = false;
    this.status = 'waiting';
    this.open = {
      kind: 'wait',
      startMs: Date.parse(createdAt),
      ...(payload.dueAt === undefined ? {} : { dueAt: payload.dueAt }),
    };
    this.tell({
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
    this.resuming = true;
    this.status = 'waiting';
    this.open = {
      kind: 'wait',
      startMs: Date.parse(createdAt),
      ...(dueAt === undefined ? {} : { dueAt }),
    };
    this.tell({
      kind: 'wait',
      outcome: 'waiting',
      tone: 'waiting',
      startedAt: createdAt,
      ...(dueAt === undefined ? {} : { dueAt }),
    });
  }

  private skip(createdAt: string, reasonCode: string | undefined): void {
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
    this.tell({
      kind: 'skipped',
      outcome: 'skipped',
      tone: 'skipped',
      startedAt: createdAt,
      endedAt: createdAt,
      ...(reasonCode === undefined ? {} : { reasonCode }),
    });
  }

  private addOutput(
    outputRef: WorkflowRunEvent['payload']['outputRef'],
    attemptNumber: number | undefined,
  ): void {
    if (outputRef === undefined || outputRef.kind === 'reused') return;
    const attempt = attemptNumber === undefined ? {} : { attemptNumber };
    switch (outputRef.kind) {
      case 'call':
        this.outputs.push({
          kind: 'call',
          callId: outputRef.callId,
          ...attempt,
        });
        break;
      case 'artifact':
        this.outputs.push({
          kind: 'artifact',
          artifactId: outputRef.artifactId,
          ...attempt,
        });
        break;
      case 'inline':
        this.outputs.push({
          kind: 'inline',
          attemptId: outputRef.attemptId,
          ...attempt,
        });
        break;
    }
  }

  /** Closes whatever is still open using the node summary, if it's final. */
  public settle(
    summary: WorkflowNodeRunSummary | undefined,
    runEndMs: number | null,
  ): void {
    this.#source = 'summary';
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
        summary.safeErrorCode === null
          ? {}
          : { safeErrorCode: summary.safeErrorCode },
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
