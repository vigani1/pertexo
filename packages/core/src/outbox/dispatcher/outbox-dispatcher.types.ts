import type { outboxEvents } from '@pertexo/database/schema';
export type LeasedOutboxEvent = Readonly<
  Pick<
    typeof outboxEvents.$inferSelect,
    | 'aggregateId'
    | 'aggregateType'
    | 'availableAt'
    | 'id'
    | 'jobName'
    | 'payloadChecksum'
    | 'publishAttempts'
    | 'redeliveries'
    | 'workspaceId'
  > & {
    leaseExpiresAt: Date;
    leaseOwner: string;
    leaseToken: string;
    /** Each consumer validates its historical job payload at receipt. */
    payload: unknown;
  }
>;

/** A failed publication either tries again or, for a row that can never publish, ends. */
export type ReleaseInput = Readonly<{
  id: string;
  leaseToken: string;
  errorCode: string;
}> &
  (
    | Readonly<{ disposition: 'retry'; retryDelayMillis: number }>
    | Readonly<{ disposition: 'fail' }>
  );

export type ObserveOutboxBacklogInput = Readonly<{
  enabledJobNames: readonly string[];
}>;
export type ReleaseOutboxResult = 'retry_scheduled' | 'failed' | 'not_leased';

export type OutboxBacklogSnapshot = Readonly<{
  backlog: number;
  /** Age of the oldest due, claimable row. Omitted when the backlog is empty. */
  oldestAgeSeconds?: number;
}>;

export interface OutboxDispatcherDatabase {
  claimBatch(input: ClaimOutboxBatchInput): Promise<ClaimOutboxBatchResult>;
  markPublished(eventId: string, leaseToken: string): Promise<boolean>;
  releaseOrFail(input: ReleaseInput): Promise<ReleaseOutboxResult>;
  observeBacklog(
    input: ObserveOutboxBacklogInput,
  ): Promise<OutboxBacklogSnapshot>;
  /** Calls `onRows` when rows may be ready, until `signal` ends it. Never rejects. */
  watchForRows(onRows: () => void, signal: AbortSignal): Promise<void>;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}

export type ClaimOutboxBatchInput = Readonly<{
  enabledJobNames: readonly string[];
  leaseDurationMillis: number;
  leaseOwner: string;
  leaseToken: string;
  limit: number;
}>;

export type ClaimOutboxBatchResult = Readonly<{
  events: readonly LeasedOutboxEvent[];
}>;
