import type {
  PreviewAttemptLease,
  PreviewDelivery,
  PreviewTerminalOutcome,
} from '../contract.js';
import type { CodeDiagnostics } from '@pertexo/node-sdk';
import type { createPreviewAttemptRunStore } from './store.js';

export type PreviewClaimResult =
  | Readonly<{ kind: 'claimed'; lease: PreviewAttemptLease }>
  | Readonly<{ kind: 'duplicate' }>;

export type PreviewHeartbeatResult = Readonly<{
  attemptLeaseExpiresAt: Date;
  runExecutionDeadlineAt: Date;
}>;

export type PreviewCompletionResult = Readonly<{
  kind: 'committed' | 'duplicate';
}>;

/** A lease names one attempt, and the worker proves it still holds it. */
type HeldLease = Pick<
  PreviewAttemptLease,
  'attemptFenceToken' | 'previewAttemptId' | 'previewRunId' | 'workspaceId'
>;

export type ClaimPreviewDeliveryInput = Readonly<{
  delivery: PreviewDelivery;
  leaseDurationSeconds: number;
  previewAttemptId: string;
  previewRunId: string;
  signal?: AbortSignal;
  workerId: string;
  workspaceId: string;
}>;

export type MarkPreviewDispatchedInput = Readonly<{
  lease: HeldLease;
  connectionFence?: Readonly<{
    connectionId: string;
    expectedProviderKey: string;
    expectedAuthType: string;
    secretVersionId: string;
  }>;
  providerDispatchBinding?: string;
  signal?: AbortSignal;
  workerId: string;
}>;

export type HeartbeatPreviewLeaseInput = Readonly<{
  lease: HeldLease;
  leaseDurationSeconds: number;
  signal?: AbortSignal;
  workerId: string;
}>;

export type CompletePreviewAttemptInput = Readonly<{
  delivery: PreviewDelivery;
  lease: HeldLease;
  outcome: PreviewTerminalOutcome;
  codeDiagnostics?: CodeDiagnostics;
  signal?: AbortSignal;
  workerId: string;
}>;

/** What a worker runs an attempt with. Closing it belongs to whoever opened it. */
export type PreviewAttemptRunStore = Omit<
  ReturnType<typeof createPreviewAttemptRunStore>,
  'close'
>;
