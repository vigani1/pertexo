import type { WorkspaceVariableValues } from '@pertexo/workflow-model';
import type { PREVIEW_STATUS } from './state.js';

import type { parseStoredExecutionValue } from '../runs/values/stored-execution.js';
export type PreviewStatus =
  (typeof PREVIEW_STATUS)[keyof typeof PREVIEW_STATUS];

export type PreviewDelivery = Readonly<{
  outboxEventId: string;
  payloadChecksum: string;
}>;

export type PreviewTerminalOutcome =
  | Readonly<{
      output: ReturnType<typeof parseStoredExecutionValue>;
      status: typeof PREVIEW_STATUS.succeeded;
    }>
  | Readonly<{
      safeErrorCode: string;
      /** The step's own reason, when it refused its input or setup. */
      errorSummary?: string;
      status: Exclude<
        PreviewStatus,
        | typeof PREVIEW_STATUS.queued
        | typeof PREVIEW_STATUS.running
        | typeof PREVIEW_STATUS.succeeded
      >;
    }>;

export type PreviewAttemptLease = Readonly<{
  attemptFenceToken: number;
  // The tenant scope travels with every lease so worker code cannot mix
  // workspaces when composing capabilities or completing work.
  workspaceId: string;
  definitionKey: string;
  definitionVersion: number;
  dryRun: 'not_supported' | 'provider_supported';
  executableNode: Readonly<Record<string, unknown>>;
  executorKey: string;
  executorVersion: number;
  executionDeadlineAt: Date;
  retentionExpiresAt: Date;
  input: ReturnType<typeof parseStoredExecutionValue>;
  /** The step whose prior test supplied `input`, when one did. */
  priorPreviewNodeId?: string;
  variables?: WorkspaceVariableValues;
  mayContactProvider: boolean;
  mayCauseExternalSideEffect: boolean;
  nodeId: string;
  operationKey?: string;
  previewAttemptId: string;
  previewRunId: string;
  providerKey?: string;
  providerIdempotencyKey?: string;
  providerDispatchBinding?: string;
  providerDispatchUnresolved?: true;
  sideEffectClass: 'safe' | 'idempotent_with_key' | 'unsafe';
  traceparent?: string;
  workflowId: string;
}>;
