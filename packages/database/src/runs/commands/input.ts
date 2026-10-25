import type { InitialCheckpointFactory } from './initial-checkpoint.js';
import type { WorkflowRecoveryPreparation } from '../recovery/contract.js';

export interface StartInput {
  actorId: string;
  workspaceId: string;
  workflowId: string;
  idempotencyKeyHash: string;
  requestHash: string;
  scope: string;
  checkpointFactory: InitialCheckpointFactory;
  input?: unknown;
  expectedPublishedVersionId?: string | undefined;
  deadlineAt?: Date | undefined;
  requestId?: string | undefined;
  traceId?: string | undefined;
  traceparent?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface ReplayInput {
  actorId: string;
  workspaceId: string;
  sourceRunId: string;
  workflowVersionId: string;
  idempotencyKeyHash: string;
  requestHash: string;
  scope: string;
  input: unknown;
  checkpointFactory: InitialCheckpointFactory;
  deadlineAt?: Date | undefined;
  requestId?: string | undefined;
  traceId?: string | undefined;
  traceparent?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface CancelInput {
  actorId: string;
  workspaceId: string;
  runId: string;
  reason?: string | undefined;
  requestId?: string | undefined;
  traceId?: string | undefined;
  traceparent?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface RecoveryPreviewInput {
  actorId: string;
  workspaceId: string;
  runId: string;
  prepareRecovery: WorkflowRecoveryPreparation;
  signal?: AbortSignal | undefined;
}

export interface RecoveryInput {
  workspaceId: string;
  workflowVersionId: string;
  requestHash: string;
  sourceRunId: string;
  actorId: string;
  idempotencyKeyHash: string;
  scope: string;
  nodeRunId: string;
  prepareRecovery: WorkflowRecoveryPreparation;
  signal?: AbortSignal | undefined;
  traceparent?: string | undefined;
  deadlineAt?: Date | undefined;
  requestId?: string | undefined;
  traceId?: string | undefined;
  acknowledgePossibleEffects?: true | undefined;
  acknowledgeUnknownOutcome?: true | undefined;
}
