import { RUN_STATUS, UNSUCCESSFUL_RUN_STATUSES } from '@pertexo/workflow-model';

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

/** The terminal run statuses that raise a workspace inbox notice: every unsuccessful one (ADR 055). */
export const WORKSPACE_INBOX_FAILURE_KINDS = UNSUCCESSFUL_RUN_STATUSES;

const unsuccessfulRunEvents: ReadonlySet<string> = new Set(
  UNSUCCESSFUL_RUN_STATUSES.map((status) => `${RUN_EVENT_PREFIX}${status}`),
);

/** Whether a run event name records the run ending unsuccessfully (`run.failed`, …). */
export function isUnsuccessfulRunEvent(name: string): boolean {
  return unsuccessfulRunEvents.has(name);
}
export type WorkspaceInboxFailureKind =
  (typeof WORKSPACE_INBOX_FAILURE_KINDS)[number];
