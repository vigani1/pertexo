import { z } from 'zod';
import { mapWorkflowCallRolloutError } from '../workflow-calls/workflow-call-rollout-error.js';
import { sha256HexSchema as sha256Schema } from '../../validation/persisted-primitives.js';

const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .refine((value) => value.slice(3, 35) !== '0'.repeat(32))
  .refine((value) => value.slice(36, 52) !== '0'.repeat(16))
  .optional();

export const acceptWorkflowRunInputSchema = z
  .object({
    engineVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
    initialCheckpoint: z.unknown(),
    deadlineAt: z.date().optional(),
    keyHash: sha256Schema,
    operation: z.literal('workflow.run.accept'),
    requestHash: sha256Schema,
    replayCommandId: z.uuid().optional(),
    replaySourceRunId: z.uuid().optional(),
    runInput: z.unknown().optional(),
    scope: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    traceparent: traceparentSchema,
    triggerType: z.enum(['api', 'manual', 'replay', 'schedule', 'webhook']),
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

export class RegionalWriteAdmissionPausedError extends Error {
  public override readonly name = 'RegionalWriteAdmissionPausedError';
  public readonly retryAfterSeconds = 5;

  public constructor() {
    super('regional.write_admission_paused');
  }
}

type AdmissionSqlState = 'PTA01' | 'PTA02' | 'PTA03';

function inspectAdmissionSqlState(error: unknown): AdmissionSqlState | null {
  const visited = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 16; depth += 1) {
    if (
      (typeof current !== 'object' && typeof current !== 'function') ||
      current === null
    )
      return null;
    if (visited.has(current)) return null;
    visited.add(current);
    try {
      if (!(current instanceof Error)) return null;
      const code = Reflect.get(current, 'code') as unknown;
      if (code === 'PTA01' || code === 'PTA02' || code === 'PTA03') return code;
      current = Reflect.get(current, 'cause');
    } catch {
      return null;
    }
  }
  return null;
}

/** Operation-local SQLSTATE mapping for queued workflow-run admission. */
export function throwWorkflowRunAdmissionError(error: unknown): never {
  const code = inspectAdmissionSqlState(error);
  if (code === 'PTA02') throw new WorkspaceRunQuotaExceededError();
  if (code === 'PTA03') throw new RegionalWriteAdmissionPausedError();
  if (code === 'PTA01') throw new WorkspaceRunAdmissionDeniedError();
  throw mapWorkflowCallRolloutError(error);
}

export const acceptanceReplayInputSchema = acceptWorkflowRunInputSchema.pick({
  keyHash: true,
  operation: true,
  requestHash: true,
  scope: true,
});

export type WorkflowRunAcceptanceReplayInput = Readonly<
  z.input<typeof acceptanceReplayInputSchema>
>;

export type ParsedAcceptWorkflowRunInput = z.output<
  typeof acceptWorkflowRunInputSchema
>;
