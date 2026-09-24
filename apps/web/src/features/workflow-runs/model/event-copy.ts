import type { WorkflowRunEvent } from '@pertexo/contracts/schemas/workflow-runs';
import type { StatusTone } from '@/components/ui/status';
import { formatClock, formatDurationMs } from '@/lib/format-time';

type EventType = WorkflowRunEvent['type'];

export type EventLine = Readonly<{
  sequence: number;
  /** "+1m 12s" from the run's start. */
  offset: string;
  /** The step's name, for step events. */
  step?: string;
  sentence: string;
  tone: StatusTone;
  rawType: EventType;
  invocationKey?: string;
  hasOutput: boolean;
}>;

const eventTones: Readonly<Record<EventType, StatusTone>> = {
  'run.queued': 'queued',
  'run.started': 'live',
  'run.waiting': 'waiting',
  'run.cancel_requested': 'waiting',
  'run.succeeded': 'success',
  'run.failed': 'failure',
  'run.canceled': 'canceled',
  'run.timed_out': 'timeout',
  'run.outcome_unknown': 'attention',
  'node.ready': 'queued',
  'node.started': 'live',
  'node.progress': 'live',
  'node.waiting': 'waiting',
  'node.retry_scheduled': 'waiting',
  'node.succeeded': 'success',
  'node.failed': 'failure',
  'node.skipped': 'skipped',
  'node.canceled': 'canceled',
  'node.timed_out': 'timeout',
  'node.outcome_unknown': 'attention',
};

const fixedSentences: Partial<Readonly<Record<EventType, string>>> = {
  'run.queued': 'Run queued',
  'run.started': 'Run started',
  'run.cancel_requested': 'Stop requested',
  'run.succeeded': 'Run succeeded',
  'run.failed': 'Run failed',
  'run.canceled': 'Run canceled',
  'run.timed_out': 'Run timed out',
  'run.outcome_unknown': 'Run outcome unknown',
  'node.ready': 'ready to run',
  'node.progress': 'made progress',
  'node.succeeded': 'succeeded',
  'node.failed': 'failed',
  'node.skipped': 'skipped · branch not taken',
  'node.canceled': 'canceled',
  'node.timed_out': 'timed out',
  'node.outcome_unknown': 'outcome unknown',
};

function attemptSuffix(attemptNumber: number | undefined): string {
  return attemptNumber === undefined || attemptNumber < 2
    ? ''
    : ` · attempt ${String(attemptNumber)}`;
}

function describeSentence(event: WorkflowRunEvent): string {
  const fixed = fixedSentences[event.type];
  if (fixed !== undefined) return fixed;
  const { dueAt, attemptNumber } = event.payload;
  switch (event.type) {
    case 'node.started':
      return `started${attemptSuffix(attemptNumber)}`;
    case 'node.retry_scheduled':
      return dueAt === undefined
        ? `retry scheduled${attemptSuffix(attemptNumber)}`
        : `retry scheduled in ${formatDurationMs(
            Date.parse(dueAt) - Date.parse(event.createdAt),
          )}${attemptSuffix(attemptNumber)}`;
    case 'node.waiting':
      return dueAt === undefined
        ? 'waiting'
        : `waiting until ${formatClock(dueAt)}`;
    default:
      return dueAt === undefined
        ? 'Run is waiting'
        : `Run is waiting until ${formatClock(dueAt)}`;
  }
}

/**
 * A readable log line for one event. Step events lead with the step's name;
 * the raw event type stays available for the mono secondary line.
 */
export function describeRunEvent(
  event: WorkflowRunEvent,
  runStartMs: number,
  stepLabel: (event: WorkflowRunEvent) => string | undefined,
): EventLine {
  const step = event.type.startsWith('node.') ? stepLabel(event) : undefined;
  const offsetMs = Math.max(0, Date.parse(event.createdAt) - runStartMs);
  return {
    sequence: event.sequence,
    offset: `+${formatDurationMs(offsetMs)}`,
    ...(step === undefined ? {} : { step }),
    sentence: describeSentence(event),
    tone: eventTones[event.type],
    rawType: event.type,
    ...(event.payload.invocationKey === undefined
      ? {}
      : { invocationKey: event.payload.invocationKey }),
    hasOutput: event.payload.outputRef !== undefined,
  };
}
