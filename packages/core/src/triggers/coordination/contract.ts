import type { InitialCheckpointFactory } from '../../runs/commands/initial-checkpoint.js';

import type { PublishedWorkflow } from '../../runs/queries/execution/contract.js';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import type {
  EventCoordinationPolicy,
  EventCoordinationReceipt,
} from '@pertexo/workflow-model';
export type PreparedEventCoordination = Readonly<{
  policy: EventCoordinationPolicy;
  keyHash: string | null;
  policyHash: string;
  inputJson: string;
}>;
export type CoordinateEventInput = Readonly<{
  eventId: string;
  workflowId: string;
  nodeId: string;
  source: 'webhook' | 'form';
  endpointId?: string;
  startedBy?: string;
  version: PublishedWorkflow;
  prepared: PreparedEventCoordination;
}>;
export type CoordinateEventResult =
  | EventCoordinationReceipt
  | Readonly<{ runId: string; replayed: boolean }>
  | Readonly<{ skipped: true; reason: 'concurrency_limit' }>;
export type StartCoordinatedRun = (
  transaction: WorkspaceTransaction,
  eventId: string,
) => Promise<{ runId: string; duplicate: boolean }>;

export type ScanDueEventsInput = Readonly<{
  limit: number;
  checkpointFactory: InitialCheckpointFactory;
  signal?: AbortSignal;
}>;
