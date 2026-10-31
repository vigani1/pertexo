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

export interface StalledWorkStore {
  /** Settles a bounded batch of overdue work; one bad row never stops the rest. */
  recoverDue(
    limit: number,
    signal: AbortSignal,
  ): Promise<
    Readonly<{
      recovered: readonly StalledWorkRecovery[];
      failed: readonly StalledWorkFailure[];
    }>
  >;
  close(): Promise<void>;
}

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
}>;
