import type { FailureNotificationDestinationConfig } from '@pertexo/workflow-model';

import type {
  CommandMetadata,
  IdempotentCommandMetadata,
} from './commands.repository.js';
import type { FailureNotificationDestinationRecord } from './records.queries.js';

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
