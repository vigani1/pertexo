/** One thing the scanner did, so the worker can log it with the run it acted on. */
export type StalledWorkRecovery = Readonly<{ workspaceId: string }> &
  (
    | Readonly<{
        kind: 'attempt_reclaimed' | 'attempt_marked_unknown';
        runId: string;
        attemptId: string;
      }>
    | Readonly<{
        kind: 'delivery_replaced';
        runId: string;
        jobName: string;
        replacedEventId: string;
        outboxEventId: string;
      }>
    | Readonly<{
        kind: 'delivery_redelivered' | 'delivery_given_up';
        outboxEventId: string;
        jobName: string;
        aggregateId: string;
        redeliveries: number;
      }>
  );

export type StalledWorkFailure = Readonly<{
  workspaceId: string;
  /** The attempt or outbox event the scanner could not settle. */
  targetId: string;
  error: unknown;
}>;

/** A whole stage of the scan that couldn't run, such as reading expired leases. */
export type StalledWorkStageFailure = Readonly<{
  stage:
    | 'expired_leases'
    | 'overdue_deliveries'
    | 'failed_run_jobs'
    | 'failed_error_workflow_deliveries'
    | 'undated_deliveries';
  error: unknown;
}>;

export type StuckRun = Readonly<{
  workspaceId: string;
  runId: string;
  status: string;
  since: Date;
}>;

export type FailedOutboxEvent = Readonly<{
  workspaceId: string;
  outboxEventId: string;
  jobName: string;
  aggregateId: string;
  failedAt: Date;
  lastErrorCode: string | null;
}>;

export type StuckWork = Readonly<{
  runs: readonly StuckRun[];
  failedOutboxEvents: readonly FailedOutboxEvent[];
  nextCursor: string | null;
}>;
