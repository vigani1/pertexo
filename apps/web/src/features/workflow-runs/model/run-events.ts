import {
  workflowRunEventSchema,
  type WorkflowRunEvent,
  type WorkflowRunSummary,
} from '@pertexo/contracts/schemas/workflow-runs';
import type { SseMessage } from '@/lib/api/sse';

/** Enough for the thread view of long, retry-heavy runs; still bounded. */
export const RUN_TIMELINE_LIMIT = 500;

const terminalRunStatuses = new Set<WorkflowRunSummary['status']>([
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);

const terminalEventTypes = new Set<WorkflowRunEvent['type']>([
  'run.succeeded',
  'run.failed',
  'run.canceled',
  'run.timed_out',
  'run.outcome_unknown',
]);

export function decodeRunEvent(message: SseMessage): WorkflowRunEvent {
  let value: unknown;
  try {
    value = JSON.parse(message.data) as unknown;
  } catch (cause) {
    throw new Error('A run event contained invalid JSON.', { cause });
  }
  const event = workflowRunEventSchema.parse(value);
  if (message.id !== String(event.sequence) || message.event !== event.type)
    throw new Error('A run event ID or type did not match its payload.');
  return event;
}

export function appendRunEvent(
  timeline: readonly WorkflowRunEvent[],
  event: WorkflowRunEvent,
): Readonly<{ timeline: readonly WorkflowRunEvent[]; truncated: number }> {
  const next = [...timeline, event];
  const overflow = Math.max(0, next.length - RUN_TIMELINE_LIMIT);
  return {
    timeline: overflow === 0 ? next : next.slice(overflow),
    truncated: overflow,
  };
}

export function classifyRunEvent(
  cursor: number,
  event: WorkflowRunEvent,
): 'append' | 'duplicate' {
  if (event.sequence <= cursor) return 'duplicate';
  if (event.sequence !== cursor + 1)
    throw new Error('The run event stream skipped an event.');
  return 'append';
}

export function isTerminalRunStatus(
  status: WorkflowRunSummary['status'],
): boolean {
  return terminalRunStatuses.has(status);
}

export function isTerminalRunEvent(event: WorkflowRunEvent): boolean {
  return terminalEventTypes.has(event.type);
}
