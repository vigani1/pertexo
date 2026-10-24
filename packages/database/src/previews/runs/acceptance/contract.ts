import type { CodeDiagnostics } from '@pertexo/node-sdk';
import { definitionIdentitySchema } from '@pertexo/node-sdk';

import { z } from 'zod';

import { executableNodeSchema } from '../../executable-node.js';
import { traceparentSchema, type PreviewStatus } from '../../contract.js';

import type { parseStoredExecutionValue } from '../../../platform/stored-execution-value.js';

import { sha256HexSchema } from '../../../platform/persisted-primitives.js';

const identityKeySchema = definitionIdentitySchema.shape.key;

const integrationKeySchema = z.string().regex(/^[a-z][a-z0-9._:-]*$/u);

export const PREVIEW_RETENTION_MAX_MS = 7 * 24 * 60 * 60 * 1_000;

export const PREVIEW_EXECUTION_TIMEOUT_MAX_MS = 5 * 60 * 1_000;

export const inputSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual'), value: z.unknown() }).strict(),
  z
    .object({ kind: z.literal('prior_preview'), previewRunId: z.uuid() })
    .strict(),
]);

export const acceptPreviewRunInputSchema = z
  .object({
    actorUserId: z.uuid(),
    definitionKey: identityKeySchema,
    definitionVersion: z.number().int().positive(),
    draftFingerprint: sha256HexSchema,
    draftRevision: z.number().int().positive(),
    expectedSampleId: z.uuid().nullable().optional(),
    dryRun: z.enum(['not_supported', 'provider_supported']),
    executableNode: executableNodeSchema,
    executorKey: identityKeySchema,
    executorVersion: z.number().int().positive(),
    executionDeadlineAt: z.date(),
    expiresAt: z.date(),
    input: inputSourceSchema,
    keyHash: sha256HexSchema,
    mayContactProvider: z.boolean(),
    mayCauseExternalSideEffect: z.boolean(),
    nodeId: z.string().min(1).max(256),
    operation: z.literal('preview.execute'),
    operationKey: integrationKeySchema.max(128).optional(),
    providerKey: integrationKeySchema.max(64).optional(),
    providerIdempotencyKey: z.string().min(1).max(256).optional(),
    requestHash: sha256HexSchema,
    requestId: z.string().min(1).max(128).optional(),
    scope: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    sideEffectClass: z.enum(['safe', 'idempotent_with_key', 'unsafe']),
    traceId: z.string().min(1).max(128).optional(),
    traceparent: traceparentSchema,
    workflowId: z.uuid(),
  })
  .strict()
  .refine(
    (input) =>
      input.sideEffectClass !== 'idempotent_with_key' ||
      input.providerIdempotencyKey !== undefined,
    'idempotent execution requires a provider idempotency key',
  )
  .refine(
    (input) =>
      (input.providerKey === undefined) === (input.operationKey === undefined),
    'provider and operation classification must be supplied together',
  );

export const resultRefSchema = z.union([
  z.object({ outboxEventId: z.uuid(), previewAttemptId: z.uuid() }).strict(),
  z.object({ pinnedSampleId: z.uuid() }).strict(),
]);

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

export class PreviewIdempotencyConflictError extends Error {
  public override readonly name = 'PreviewIdempotencyConflictError';
  public constructor() {
    super('request.idempotency_conflict');
  }
}

export class PreviewAcceptanceCorruptError extends Error {
  public override readonly name = 'PreviewAcceptanceCorruptError';
  public constructor() {
    super('Persisted preview acceptance is incomplete or invalid');
  }
}

export class PreviewAdmissionDeniedError extends Error {
  public override readonly name = 'PreviewAdmissionDeniedError';
  public constructor(reason: 'actor' | 'deadline' | 'draft' | 'retention') {
    super(`preview.${reason}_denied`);
  }
}

export class PriorPreviewInputUnavailableError extends Error {
  public override readonly name = 'PriorPreviewInputUnavailableError';
  public constructor() {
    super('preview.input_unavailable');
  }
}
