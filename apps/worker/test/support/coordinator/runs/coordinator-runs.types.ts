export interface AcceptedRun {
  readonly outboxEventId: string;
  readonly runId: string;
}

export interface AcceptedReplayRun extends AcceptedRun {
  readonly sourceRunId: string;
}

export interface CoordinatorRedeliveryHarness {
  publishInitial(): Promise<void>;
  redeliver(): Promise<void>;
  close(): Promise<void>;
}
