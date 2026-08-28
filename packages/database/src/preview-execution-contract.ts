import { z } from 'zod';

import {
  PREVIEW_STATUS,
  traceparentSchema,
  type PreviewStatus,
} from './preview-execution-acceptance.js';
import type { parseStoredExecutionValueV1 } from './stored-execution-value.js';

export function optionsFor(signal: AbortSignal | undefined): {
  signal?: AbortSignal;
} {
  return signal === undefined ? {} : { signal };
}

export const TERMINAL_PREVIEW_STATUSES: ReadonlySet<string> = new Set([
  PREVIEW_STATUS.canceled,
  PREVIEW_STATUS.failed,
  PREVIEW_STATUS.outcomeUnknown,
  PREVIEW_STATUS.succeeded,
  PREVIEW_STATUS.timedOut,
]);

export const previewConsumerName = 'preview-attempt-worker';
export const previewReconcilerConsumerName = 'preview-attempt-reconciler';

export const safeErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9._:-]{0,127}$/u);

export const previewDeliveryPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.uuid(),
    outboxEventId: z.uuid(),
    previewRunId: z.uuid(),
    previewAttemptId: z.uuid(),
    traceparent: traceparentSchema,
  })
  .strict();

export const previewReconciliationPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.uuid(),
    outboxEventId: z.uuid(),
    previewRunId: z.uuid(),
    previewAttemptId: z.uuid(),
    attemptFenceToken: z.number().int().nonnegative(),
    traceparent: traceparentSchema,
  })
  .strict();

export type PreviewDelivery = Readonly<{
  outboxEventId: string;
  payloadChecksum: string;
}>;

export type PreviewTerminalOutcome =
  | Readonly<{
      output: ReturnType<typeof parseStoredExecutionValueV1>;
      status: typeof PREVIEW_STATUS.succeeded;
    }>
  | Readonly<{
      safeErrorCode: z.output<typeof safeErrorCodeSchema>;
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
  compatibilityReleaseEpoch: number;
  compatibilityReleaseFingerprint: string;
  definitionKey: string;
  definitionVersion: number;
  dryRun: 'not_supported' | 'provider_supported';
  executableNode: Readonly<Record<string, unknown>>;
  executorKey: string;
  executorVersion: number;
  expiresAt: Date;
  input: ReturnType<typeof parseStoredExecutionValueV1>;
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

export class PreviewDeliveryMismatchError extends Error {
  public override readonly name = 'PreviewDeliveryMismatchError';
  public constructor() {
    super('Preview delivery does not match its durable outbox aggregate');
  }
}

export class PreviewAttemptStateError extends Error {
  public readonly code: string;
  public constructor(code: string) {
    super(`Preview attempt cannot continue: ${code}`);
    this.code = code;
    this.name = 'PreviewAttemptStateError';
  }
}

export function previewPairConsistent(
  attemptStatus: string,
  runStatus: string,
): boolean {
  const allowed: Record<string, readonly string[]> = {
    canceled: [PREVIEW_STATUS.canceled],
    failed: [PREVIEW_STATUS.failed],
    outcome_unknown: [PREVIEW_STATUS.outcomeUnknown],
    queued: [PREVIEW_STATUS.queued],
    running: [PREVIEW_STATUS.queued, PREVIEW_STATUS.running],
    succeeded: [PREVIEW_STATUS.succeeded],
    timed_out: [PREVIEW_STATUS.timedOut],
  };
  return allowed[attemptStatus]?.includes(runStatus) ?? false;
}
