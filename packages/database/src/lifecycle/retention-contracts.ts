import type { TransientDataReapResult } from './transient-data-retention.js';

export type RetentionKind =
  | 'workflow_run_input'
  | 'execution_detail'
  | 'run_summary'
  | 'trigger_summary'
  | 'audit_security';

export interface StartWorkflowRunInputRetentionDryRunInput {
  readonly batchId: string;
  readonly cutoffAt: Date;
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly retentionKind?: RetentionKind;
  readonly signal?: AbortSignal;
  readonly workspaceId: string;
}

export type StartWorkflowRunInputRetentionInput =
  StartWorkflowRunInputRetentionDryRunInput;

export interface RetentionDryRunClaim {
  readonly batchId: string;
  readonly cutoffAt: Date;
  readonly cursorExpiresAt: Date | null;
  readonly cursorId: string | null;
  readonly dryRunCursor: RetentionDryRunTuple | null;
  readonly dryRunUpper: RetentionDryRunTuple | null;
  readonly leaseExpiresAt: Date;
  readonly leaseFence: number;
  readonly leaseToken: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly retentionKind: RetentionKind;
  readonly workspaceId: string;
}

export interface RetentionDryRunPageResult {
  readonly completed: boolean;
  readonly cursorExpiresAt: Date | null;
  readonly cursorId: string | null;
  readonly eligibleDelta: number;
  readonly examinedDelta: number;
  readonly outcome: 'completed' | 'progressed' | 'stale';
  readonly stale: boolean;
}

export type RetentionDryRunTuple = Readonly<{
  type: 'timestamp_uuid' | 'timestamp_uuid_text_text' | 'uuid' | 'uuid_bigint';
  values: readonly (number | string)[];
}>;

export type RetentionDryRunProcessResult =
  | Readonly<{ status: 'idle' }>
  | Readonly<{
      batchId: string;
      eligibleCount: number;
      examinedCount: number;
      pageCount: number;
      retentionKind: RetentionKind;
      status: 'completed' | 'stale';
      workspaceId: string;
    }>;

export interface RetentionDatabaseOptions {
  readonly leaseOwner: string;
  readonly leaseSeconds?: number;
  readonly maxPagesPerBatch?: number;
  readonly pageSize?: number;
}

export interface RetentionScheduleResult {
  readonly capacityLimited: boolean;
  readonly cutoffAt: Date;
  readonly scannedCount: number;
  readonly scheduledCount: number;
}

export type RegionalReplicaLagObservation = Readonly<{
  replayLagMillis: number | null;
  replicationState: string;
  status: 'open' | 'paused' | 'unavailable';
}>;

export interface RetentionDatabase {
  checkReadiness(input: {
    readonly expectedMaintenanceRole: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  claimDryRuns(signal?: AbortSignal): Promise<readonly RetentionDryRunClaim[]>;
  close(): Promise<void>;
  executeDryRunPage(
    claim: RetentionDryRunClaim,
    signal?: AbortSignal,
  ): Promise<RetentionDryRunPageResult>;
  processNext(signal?: AbortSignal): Promise<RetentionDryRunProcessResult>;
  processOperatorRerun(
    signal?: AbortSignal,
  ): Promise<OperatorMaintenanceRerunResult | null>;
  recordRegionalReplicaLag(
    applicationName: string,
    signal?: AbortSignal,
  ): Promise<RegionalReplicaLagObservation>;
  reapTransientData(signal?: AbortSignal): Promise<TransientDataReapResult>;
  scheduleEnforcement(signal?: AbortSignal): Promise<RetentionScheduleResult>;
  startDryRun(
    input: StartWorkflowRunInputRetentionDryRunInput,
  ): Promise<string>;
  startEnforcement(input: StartWorkflowRunInputRetentionInput): Promise<string>;
}

export type OperatorMaintenanceRerunResult = Readonly<{
  commandId: string;
  outcome: string;
  targetId: string;
  targetType: 'retention_batch' | 'workspace_purge_job';
  workspaceId: string;
}>;

export type RetentionEnforcementProcessResult =
  | Readonly<{ status: 'idle' }>
  | Readonly<{
      batchId: string;
      eligibleCount: number;
      examinedCount: number;
      pageCount: number;
      retentionKind: RetentionKind;
      status: 'completed' | 'paused' | 'released' | 'stale';
      workspaceId: string;
    }>;

export interface RetentionEnforcementCoordinator {
  close(): Promise<void>;
  processNext(signal?: AbortSignal): Promise<RetentionEnforcementProcessResult>;
}

export interface RetentionEnforcementCoordinatorOptions extends RetentionDatabaseOptions {
  readonly externalOperationTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}
