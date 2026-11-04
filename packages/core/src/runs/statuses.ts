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

/** What makes a run or node attempt's outcome worth reporting as a failure. */
export const UNSUCCESSFUL_STATUSES = [
  RUN_STATUS.failed,
  RUN_STATUS.timedOut,
  RUN_STATUS.outcomeUnknown,
] as const;
