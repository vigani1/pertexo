import type { CodeDiagnostics } from '@pertexo/node-sdk';
import type { parseStoredExecutionValue } from '../../platform/stored-execution-value.js';
import type { PreviewStatus } from '../contract.js';

export type ResolvePreviewReplayInput = Readonly<{
  actorUserId: string;
  workflowId: string;
  keyHash: string;
  requestHash: string;
}>;

// Projection joins preview runs, attempts and stored acceptance receipts.
export type PreviewReplayRecord = Readonly<{
  codeDiagnostics?: CodeDiagnostics;
  id: string;
  workspaceId: string;
  workflowId: string;
  draftRevision: number;
  nodeId: string;
  status: PreviewStatus;
  sideEffectClass: 'safe' | 'idempotent_with_key' | 'unsafe';
  mayContactProvider: boolean;
  mayCauseExternalSideEffect: boolean;
  dryRun: 'not_supported' | 'provider_supported';
  pinnedSampleId?: string | null;
  output?: ReturnType<typeof parseStoredExecutionValue> | null;
  completedAt?: Date | null;
  createdAt: Date;
  expiresAt: Date;
}>;
