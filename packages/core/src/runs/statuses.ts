import { RUN_STATUS } from '@pertexo/workflow-model';

/** A run that can still change. */
export const ACTIVE_RUN_STATUSES = [
  RUN_STATUS.queued,
  RUN_STATUS.running,
  RUN_STATUS.waiting,
] as const;

/** A run that has finished, whatever way it ended. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  RUN_STATUS.succeeded,
  RUN_STATUS.failed,
  RUN_STATUS.canceled,
  RUN_STATUS.timedOut,
  RUN_STATUS.outcomeUnknown,
]);

const RUN_EVENT_PREFIX = 'run.';

/** Whether a run event name records the run finishing (`run.succeeded`, …). */
export function isTerminalRunEvent(name: string): boolean {
  return (
    name.startsWith(RUN_EVENT_PREFIX) &&
    TERMINAL_RUN_STATUSES.has(name.slice(RUN_EVENT_PREFIX.length))
  );
}

/** What makes a run or node attempt's outcome worth reporting as a failure. */
export const UNSUCCESSFUL_STATUSES = [
  RUN_STATUS.failed,
  RUN_STATUS.timedOut,
  RUN_STATUS.outcomeUnknown,
] as const;

/** The terminal run statuses that raise a workspace inbox notice (ADR 055). */
export const WORKSPACE_INBOX_FAILURE_KINDS = [
  'failed',
  'timed_out',
  'outcome_unknown',
] as const;
export type WorkspaceInboxFailureKind =
  (typeof WORKSPACE_INBOX_FAILURE_KINDS)[number];
