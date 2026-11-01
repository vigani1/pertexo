import type { outboxEvents } from '@pertexo/database/schema';
import type { ClaimInput } from './input.js';
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

import type { ReleaseInput } from './input.js';

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
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}

export type ClaimOutboxBatchInput = Readonly<
  Omit<ClaimInput, 'enabledJobNames'> & {
    enabledJobNames: readonly string[];
  }
>;

export type ClaimOutboxBatchResult = Readonly<{
  events: readonly LeasedOutboxEvent[];
}>;
