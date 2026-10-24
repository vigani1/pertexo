import type { acceptPreviewRunInputSchema } from './input.js';
import type { CodeDiagnostics } from '@pertexo/node-sdk';

import type { z } from 'zod';

import type { PreviewStatus } from '../../contract.js';

import type { parseStoredExecutionValue } from '../../../platform/stored-execution-value.js';

type ParsedPreviewRunInput = z.input<typeof acceptPreviewRunInputSchema>;

export type AcceptPreviewRunInput = Readonly<
  Omit<ParsedPreviewRunInput, 'executableNode'> & {
    executableNode: Readonly<Record<string, unknown>>;
  }
>;

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
