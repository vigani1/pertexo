import { z } from 'zod';

export const workflowRunIdentifierSchema = z.uuid();
export const workflowRunParamsSchema = z
  .object({ workspaceId: z.uuid(), runId: workflowRunIdentifierSchema })
  .strict();
export const workflowRunStartParamsSchema = z
  .object({ workspaceId: z.uuid(), workflowId: z.uuid() })
  .strict();

export const workflowRunStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);
export const workflowNodeRunStatusSchema = z.enum([
  'pending',
  'ready',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'skipped',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);
export const workflowRunTriggerTypeSchema = z.enum([
  'api',
  'manual',
  'replay',
  'schedule',
  'webhook',
]);

/**
 * The server applies the exact bounded execution-value contract before
 * persistence. The wire schema remains JSON-shaped without exposing that
 * internal storage envelope.
 */
export const workflowRunStartRequestSchema = z
  .object({
    input: z.unknown().optional(),
    deadlineAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const workflowRunReplayRequestSchema = z
  .object({
    workflowVersionId: z.uuid(),
    input: z
      .unknown()
      .refine((value) => value !== undefined, 'Replay input is required'),
    deadlineAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const workflowRunCancelRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .strict();

export const workflowRunSummarySchema = z
  .object({
    id: workflowRunIdentifierSchema,
    workspaceId: z.uuid(),
    workflowId: z.uuid(),
    workflowVersionId: z.uuid(),
    status: workflowRunStatusSchema,
    triggerType: workflowRunTriggerTypeSchema,
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    startedAt: z.iso.datetime({ offset: true }).nullable(),
    completedAt: z.iso.datetime({ offset: true }).nullable(),
    deadlineAt: z.iso.datetime({ offset: true }).nullable(),
    cancelRequestedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();

export const workflowNodeRunSummarySchema = z
  .object({
    id: z.uuid(),
    nodeId: z.string().min(1).max(256),
    invocationKey: z.string().min(1).max(1_024),
    status: workflowNodeRunStatusSchema,
    currentAttemptNumber: z.number().int().nonnegative(),
    startedAt: z.iso.datetime({ offset: true }).nullable(),
    completedAt: z.iso.datetime({ offset: true }).nullable(),
    resumeAt: z.iso.datetime({ offset: true }).nullable(),
    safeErrorCode: z.string().min(1).max(128).nullable(),
  })
  .strict();

export const workflowRunStartResponseSchema = z
  .object({ run: workflowRunSummarySchema, replayed: z.boolean() })
  .strict();
export const workflowRunResponseSchema = z
  .object({
    run: workflowRunSummarySchema,
    nodes: z.array(workflowNodeRunSummarySchema).max(1_000),
  })
  .strict();
export const workflowRunCancelResponseSchema = z
  .object({ run: workflowRunSummarySchema, alreadyRequested: z.boolean() })
  .strict();

export const workflowRunEventTypeSchema = z.enum([
  'run.queued',
  'run.started',
  'run.waiting',
  'run.cancel_requested',
  'run.succeeded',
  'run.failed',
  'run.canceled',
  'run.timed_out',
  'run.outcome_unknown',
  'node.ready',
  'node.started',
  'node.progress',
  'node.waiting',
  'node.retry_scheduled',
  'node.succeeded',
  'node.failed',
  'node.skipped',
  'node.canceled',
  'node.timed_out',
  'node.outcome_unknown',
]);
export const workflowRunOutputReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline'), attemptId: z.uuid() }).strict(),
  z.object({ kind: z.literal('artifact'), artifactId: z.uuid() }).strict(),
]);
export const workflowRunEventPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    invocationKey: z.string().min(1).max(1_024).optional(),
    nodeId: z.string().min(1).max(256).optional(),
    nodeRunId: z.uuid().optional(),
    attemptId: z.uuid().optional(),
    attemptNumber: z.number().int().nonnegative().optional(),
    dueAt: z.iso.datetime({ offset: true }).optional(),
    safeErrorCode: z.string().min(1).max(128).optional(),
    reasonCode: z.string().min(1).max(128).optional(),
    outputRef: workflowRunOutputReferenceSchema.optional(),
  })
  .strict();
export const workflowRunEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    type: workflowRunEventTypeSchema,
    createdAt: z.iso.datetime({ offset: true }),
    payload: workflowRunEventPayloadSchema,
  })
  .strict();

export const lastRunEventIdHeaderSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,14})$/u);

export type WorkflowRunSummary = z.output<typeof workflowRunSummarySchema>;
export type WorkflowNodeRunSummary = z.output<
  typeof workflowNodeRunSummarySchema
>;
export type WorkflowRunEvent = z.output<typeof workflowRunEventSchema>;
export type WorkflowRunStartResponse = z.output<
  typeof workflowRunStartResponseSchema
>;
export type WorkflowRunReplayRequest = z.output<
  typeof workflowRunReplayRequestSchema
>;
export type WorkflowRunResponse = z.output<typeof workflowRunResponseSchema>;
export type WorkflowRunCancelResponse = z.output<
  typeof workflowRunCancelResponseSchema
>;
