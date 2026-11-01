import type { CodeDiagnostics } from '@pertexo/node-sdk';

import type { PreviewStatus } from '../../contract.js';

import type { parseStoredExecutionValue } from '@pertexo/database/primitives';

export type AcceptPreviewRunInput = Readonly<{
  actorUserId: string;
  definitionKey: string;
  definitionVersion: number;
  draftFingerprint: string;
  draftRevision: number;
  dryRun: 'not_supported' | 'provider_supported';
  executableNode: Readonly<Record<string, unknown>> & {
    connectionRefs?: Record<string, string>;
  };
  executorKey: string;
  executorVersion: number;
  executionDeadlineAt: Date;
  expiresAt: Date;
  input:
    | { kind: 'manual'; value: unknown }
    | { kind: 'prior_preview'; previewRunId: string };
  keyHash: string;
  mayContactProvider: boolean;
  mayCauseExternalSideEffect: boolean;
  nodeId: string;
  operation: 'preview.execute';
  requestHash: string;
  scope: string;
  sideEffectClass: 'safe' | 'idempotent_with_key' | 'unsafe';
  workflowId: string;
  expectedSampleId?: string | null | undefined;
  operationKey?: string | undefined;
  providerKey?: string | undefined;
  providerIdempotencyKey?: string | undefined;
  requestId?: string | undefined;
  traceId?: string | undefined;
  traceparent?: string | undefined;
}>;

export type ReadPreviewRunInput = Readonly<{
  actorUserId: string;
  previewRunId: string;
}>;

export type AcceptedPreviewRun = Readonly<{
  acceptedAt: Date;
  duplicate: boolean;
  expiresAt: Date;
  outboxEventId: string | null;
  previewAttemptId: string | null;
  pinnedSampleId?: string;
  pinnedOutput?: ReturnType<typeof parseStoredExecutionValue>;
  completedAt?: Date | null;
  previewRunId: string;
  status: PreviewStatus;
}>;

// Projection decodes output and joins optional attempt diagnostics.
export type PreviewRunRecord = Readonly<{
  codeDiagnostics?: CodeDiagnostics;
  errorSummary?: string;
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
  output: ReturnType<typeof parseStoredExecutionValue> | null;
  pinnedSampleId?: string | null;
  safeErrorCode: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date;
}>;
