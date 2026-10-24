export type LeasedOutboxEvent = Readonly<{
  aggregateId: string;
  aggregateType: string;
  availableAt: Date;
  id: string;
  jobName: string;
  leaseExpiresAt: Date;
  leaseOwner: string;
  leaseToken: string;
  payload: unknown;
  payloadChecksum: string;
  publishAttempts: number;
  workspaceId: string;
}>;

import type { z } from 'zod';
import type { releaseInputSchema } from './input.js';
import type {
  ClaimOutboxBatchInput,
  ClaimOutboxBatchResult,
} from './claim.repository.js';
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
  releaseOrFail(
    input: z.input<typeof releaseInputSchema>,
  ): Promise<ReleaseOutboxResult>;
  observeBacklog(
    input: ObserveOutboxBacklogInput,
  ): Promise<OutboxBacklogSnapshot>;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}
