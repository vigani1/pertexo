import type { FailureNotificationDestinationConfig } from '@pertexo/workflow-model';

export type DestinationConfig = FailureNotificationDestinationConfig;

export type StoredDestinationConfig =
  | Omit<Extract<DestinationConfig, { kind: 'email' }>, 'kind'>
  | Omit<Extract<DestinationConfig, { kind: 'slack' }>, 'kind'>;

// Projection joins destination metadata with its current version configuration.
export type FailureNotificationDestinationRecord = Readonly<{
  id: string;
  workspaceId: string;
  kind: 'slack' | 'email';
  status: 'enabled' | 'disabled';
  currentVersion: number;
  config: FailureNotificationDestinationConfig;
  createdAt: Date;
  updatedAt: Date;
}>;

export type CommandMetadata = Readonly<{
  workspaceId: string;
  actorId: string;
  requestId?: string;
  traceId?: string;
}>;

export type IdempotentCommandMetadata = CommandMetadata &
  Readonly<{
    idempotencyKey: string;
    requestHash: string;
  }>;

export type DestinationAuditTarget = Readonly<{
  id: string;
  type: 'failure_notification_destination' | 'workflow';
}>;

export type CreateDestinationInput = IdempotentCommandMetadata &
  Readonly<{ destinationId: string; config: DestinationConfig }>;

export type DestinationInput = CommandMetadata &
  Readonly<{ destinationId: string }>;

export type AppendDestinationVersionInput = IdempotentCommandMetadata &
  Readonly<{
    destinationId: string;
    expectedVersion: number;
    config: DestinationConfig;
  }>;

export type SetDestinationStatusInput = IdempotentCommandMetadata &
  Readonly<{ destinationId: string; status: 'enabled' | 'disabled' }>;

export type SetWorkflowPolicyInput = IdempotentCommandMetadata &
  Readonly<{ workflowId: string; destinationId: string }>;

export type ClearWorkflowPolicyInput = IdempotentCommandMetadata &
  Readonly<{ workflowId: string }>;

export type WorkflowPolicyInput = CommandMetadata &
  Readonly<{ workflowId: string }>;
