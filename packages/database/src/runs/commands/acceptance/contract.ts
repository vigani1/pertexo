import { z } from 'zod';

import type { RunInputValidator } from '../initial-checkpoint.js';
import type { resolveWorkflowFailureNotificationPolicy } from '../../../notifications/policies/admission.queries.js';

import { sha256HexSchema as sha256Schema } from '../../../platform/persisted-primitives.js';

import type { WorkflowRecoverySummary } from '../../recovery/contract.js';

const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .refine((value) => value.slice(3, 35) !== '0'.repeat(32))
  .refine((value) => value.slice(36, 52) !== '0'.repeat(16))
  .optional();

export const acceptWorkflowRunInputSchema = z
  .object({
    initialCheckpoint: z.unknown(),
    validateInput: z
      .custom<RunInputValidator>((value) => typeof value === 'function')
      .optional(),
    deadlineAt: z.date().optional(),
    absoluteDeadlineAt: z.date().nullable().optional(),
    startedBy: z.uuid().optional(),
    keyHash: sha256Schema,
    operation: z.literal('workflow.run.accept'),
    requestHash: sha256Schema,
    replayCommandId: z.uuid().optional(),
    replaySourceRunId: z.uuid().optional(),
    runInput: z.unknown().optional(),
    scope: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    traceparent: traceparentSchema,
    triggerType: z.enum([
      'test',
      'api',
      'manual',
      'replay',
      'schedule',
      'webhook',
      'workflow_call',
      'workflow_error',
      'form',
    ]),
    workflowId: z.uuid(),
    workflowVersionId: z.uuid(),
  })
  .strict();

export const resultRefSchema = z
  .object({
    outboxEventId: z.uuid(),
    initialCheckpointHash: sha256Schema.optional(),
  })
  .strict();

export const RUN_STATUS = {
  queued: 'queued',
  running: 'running',
  waiting: 'waiting',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'canceled',
  timedOut: 'timed_out',
  outcomeUnknown: 'outcome_unknown',
} as const;

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];

export const RUN_STATUS_VALUES = Object.values(RUN_STATUS) as [
  RunStatus,
  ...RunStatus[],
];

export const IDEMPOTENCY_STATUS = {
  inProgress: 'in_progress',
  completed: 'completed',
  failed: 'failed',
} as const;

export type IdempotencyStatus =
  (typeof IDEMPOTENCY_STATUS)[keyof typeof IDEMPOTENCY_STATUS];

export const IDEMPOTENCY_STATUS_VALUES = Object.values(IDEMPOTENCY_STATUS) as [
  IdempotencyStatus,
  ...IdempotencyStatus[],
];

export const workflowRunStatusSchema = z.enum(RUN_STATUS_VALUES);

export type AcceptWorkflowRunInput = Readonly<
  z.input<typeof acceptWorkflowRunInputSchema>
>;

export type AcceptedWorkflowRun = Readonly<{
  acceptedAt: Date;
  duplicate: boolean;
  outboxEventId: string;
  runId: string;
  status: z.output<typeof workflowRunStatusSchema>;
}>;

export class IdempotencyRequestConflictError extends Error {
  public override readonly name = 'IdempotencyRequestConflictError';

  public constructor() {
    super('request.idempotency_conflict');
  }
}

export class IdempotencyRecordCorruptError extends Error {
  public override readonly name = 'IdempotencyRecordCorruptError';

  public constructor() {
    super('Persisted workflow run acceptance is incomplete or invalid');
  }
}

export class WorkspaceRunAdmissionDeniedError extends Error {
  public override readonly name = 'WorkspaceRunAdmissionDeniedError';

  public constructor() {
    super('workspace.run_admission_denied');
  }
}

export class WorkspaceRunQuotaExceededError extends Error {
  public override readonly name = 'WorkspaceRunQuotaExceededError';
  public readonly retryAfterSeconds = 5;

  public constructor() {
    super('workspace.quota_exceeded');
  }
}

export type PreparedWorkflowRunAcceptance = Readonly<{
  runId?: string;
  variableSetRevision?: number | null;
  errorWorkflowOrigin?: boolean;
  recovery?: WorkflowRecoverySummary;
  failureNotificationPolicy: Awaited<
    ReturnType<typeof resolveWorkflowFailureNotificationPolicy>
  >;
}>;
