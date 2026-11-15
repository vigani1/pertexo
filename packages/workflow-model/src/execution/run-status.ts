export const RUN_STATUS = {
  queued: 'queued',
  running: 'running',
  waiting: 'waiting',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'canceled',
  timedOut: 'timed_out',
  outcomeUnknown: 'outcome_unknown',
} as const;

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];

export const RUN_STATUSES = Object.values(RUN_STATUS);

/** A run or step that ended without succeeding: failed, timed out or ended unknown. */
export const UNSUCCESSFUL_RUN_STATUSES = [
  RUN_STATUS.failed,
  RUN_STATUS.timedOut,
  RUN_STATUS.outcomeUnknown,
] as const;
export type UnsuccessfulRunStatus = (typeof UNSUCCESSFUL_RUN_STATUSES)[number];
