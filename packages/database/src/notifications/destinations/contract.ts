import type { FailureNotificationDestinationConfig } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';

export type DestinationConfig = FailureNotificationDestinationConfig;

export interface FailureNotificationDestinationDatabase {
  create(
    input: IdempotentCommandMetadata &
      Readonly<{
        destinationId: string;
        config: DestinationConfig;
      }>,
  ): Promise<FailureNotificationDestinationRecord>;
  get(
    input: CommandMetadata & Readonly<{ destinationId: string }>,
  ): Promise<FailureNotificationDestinationRecord>;
  list(
    input: CommandMetadata,
  ): Promise<readonly FailureNotificationDestinationRecord[]>;
  appendVersion(
    input: IdempotentCommandMetadata &
      Readonly<{
        destinationId: string;
        expectedVersion: number;
        config: DestinationConfig;
      }>,
  ): Promise<FailureNotificationDestinationRecord>;
  setStatus(
    input: IdempotentCommandMetadata &
      Readonly<{
        destinationId: string;
        status: 'enabled' | 'disabled';
      }>,
  ): Promise<FailureNotificationDestinationRecord>;
  setWorkflowPolicy(
    input: IdempotentCommandMetadata &
      Readonly<{
        workflowId: string;
        destinationId: string;
      }>,
  ): Promise<void>;
  clearWorkflowPolicy(
    input: IdempotentCommandMetadata & Readonly<{ workflowId: string }>,
  ): Promise<void>;
  getWorkflowPolicy(
    input: CommandMetadata & Readonly<{ workflowId: string }>,
  ): Promise<FailureNotificationDestinationRecord | null>;
  close(): Promise<void>;
}

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

export type DestinationTransaction = <T>(
  input: CommandMetadata,
  work: (client: PoolClient) => Promise<T>,
) => Promise<T>;
