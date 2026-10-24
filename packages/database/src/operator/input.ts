import { z } from 'zod';

export class OperatorCommandConflictError extends Error {
  public constructor() {
    super('Operator command replay conflicts with the existing request');
    this.name = 'OperatorCommandConflictError';
  }
}

const actorRefSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u);

const reasonSchema = z.string().min(1).max(512);

const signalSchema = z
  .custom<AbortSignal>((value) => value instanceof AbortSignal)
  .optional();

const baseCommandInputSchema = z.object({
  actorRef: actorRefSchema,
  commandId: z.uuid(),
  dryRun: z.boolean(),
  reason: reasonSchema,
  signal: signalSchema,
  workspaceId: z.uuid(),
});

export const redispatchInputSchema = baseCommandInputSchema
  .extend({ outboxEventId: z.uuid() })
  .strict();

export const reconcileAttemptInputSchema = baseCommandInputSchema
  .extend({
    action: z.enum(['reclaim', 'outcome_unknown']),
    attemptId: z.uuid(),
    expectedFenceToken: z.number().int().positive(),
  })
  .strict();

export const targetRunInputSchema = baseCommandInputSchema
  .extend({ runId: z.uuid() })
  .strict();

export const targetWorkflowInputSchema = baseCommandInputSchema
  .extend({ workflowId: z.uuid() })
  .strict();

export const replayRunInputSchema = baseCommandInputSchema
  .extend({
    runInput: z.unknown(),
    sourceRunId: z.uuid(),
    workflowVersionId: z.uuid(),
  })
  .strict();

export const unknownEvidenceInputSchema = baseCommandInputSchema
  .omit({ dryRun: true })
  .extend({
    attemptId: z.uuid(),
    evidenceKind: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u),
    evidenceRef: z.custom<Readonly<Record<string, unknown>>>(
      (value) =>
        typeof value === 'object' && value !== null && !Array.isArray(value),
    ),
  })
  .strict();

export const getCommandInputSchema = z
  .object({
    actorRef: actorRefSchema,
    commandId: z.uuid(),
    reason: reasonSchema,
    signal: signalSchema,
    workspaceId: z.uuid(),
  })
  .strict();

export const optionsSchema = z.object({
  lockTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
  statementTimeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
});
