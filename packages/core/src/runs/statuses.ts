/** A run that can still change. */
export const ACTIVE_RUN_STATUSES = ['queued', 'running', 'waiting'] as const;

/** A run that has finished, whatever way it ended. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);

/** What makes a run or node attempt's outcome worth reporting as a failure. */
export const UNSUCCESSFUL_STATUSES = [
  'failed',
  'timed_out',
  'outcome_unknown',
] as const;
