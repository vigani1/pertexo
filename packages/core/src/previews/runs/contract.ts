import type { CodeDiagnostics } from '@pertexo/node-sdk';
import type { parseStoredExecutionValue } from '@pertexo/database/primitives';
import type {
  PreviewDryRun,
  PreviewSideEffectClass,
  PreviewStatus,
} from '../contract.js';

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
  sideEffectClass: PreviewSideEffectClass;
  mayContactProvider: boolean;
  mayCauseExternalSideEffect: boolean;
  dryRun: PreviewDryRun;
  pinnedSampleId?: string | null;
  output?: ReturnType<typeof parseStoredExecutionValue> | null;
  completedAt?: Date | null;
  createdAt: Date;
  expiresAt: Date;
}>;
