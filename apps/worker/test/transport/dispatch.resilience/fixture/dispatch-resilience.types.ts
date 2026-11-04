export interface OutboxProofState {
  readonly failed_at: Date | null;
  readonly last_error_code: string | null;
  readonly lease_expires_at: Date | null;
  readonly lease_owner: string | null;
  readonly publish_attempts: number;
  readonly published_at: Date | null;
}

export interface ProofMeasurements {
  bullmqVersion?: string;
  drainCloseMs?: number;
  drainNoNewClaimAttempts?: number;
  forcedConsumerCloseMs?: number;
  migrationHead?: string;
  postgresFailureDetectionMs?: number;
  postgresRecoveredPublishAttempts?: number;
  postgresRecoveryMs?: number;
  postgresVersion?: string;
  queueLossRecoveredPublishAttempts?: number;
  queueLossRecoveryMs?: number;
  redisFailureDetectionMs?: number;
  redisRestartRetainedJobs?: number;
  redisUnavailableBacklog?: number;
  redisUnavailableLeaseReleased?: boolean;
  redisUnavailablePublishAttempts?: number;
  redisRecoveredPublishAttempts?: number;
  redisRecoveryMs?: number;
  redisVersion?: string;
}
