import { z } from 'zod';

export const workflowRunIdentifierSchema = z.uuid();
export const workflowRunParamsSchema = z
  .object({ workspaceId: z.uuid(), runId: workflowRunIdentifierSchema })
  .strict();
export const workflowRunListParamsSchema = z
  .object({ workspaceId: z.uuid() })
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
export const workflowRunPageLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(100);
export const workflowRunCursorSchema = z.string().min(1).max(1_024);
const workflowRunCreatedAtInputSchema = z.union([
  z.iso.datetime({ offset: true, precision: 0 }),
  z.iso.datetime({ offset: true, precision: 1 }),
  z.iso.datetime({ offset: true, precision: 2 }),
  z.iso.datetime({ offset: true, precision: 3 }),
  z.iso.datetime({ offset: true, precision: 4 }),
  z.iso.datetime({ offset: true, precision: 5 }),
  z.iso.datetime({ offset: true, precision: 6 }),
]);

/** Canonical UTC form that preserves PostgreSQL's supported microseconds. */
export function normalizeWorkflowRunCreatedAt(value: string): string {
  const parsed = workflowRunCreatedAtInputSchema.parse(value);
  const match =
    /^(?<whole>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(?<fraction>\d{1,6}))?(?<offset>Z|[+-]\d{2}:\d{2})$/u.exec(
      parsed,
    );
  if (match?.groups === undefined)
    throw new TypeError('workflow run timestamp is invalid');
  const epochMilliseconds = Date.parse(
    `${match.groups.whole}.000${match.groups.offset}`,
  );
  const utcWhole = new Date(epochMilliseconds).toISOString().slice(0, 19);
  return `${utcWhole}.${(match.groups.fraction ?? '').padEnd(6, '0')}Z`;
}

export const workflowRunCreatedAtSchema =
  workflowRunCreatedAtInputSchema.transform(normalizeWorkflowRunCreatedAt);

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

export const workflowRunListQuerySchema = z
  .object({
    limit: workflowRunPageLimitSchema.optional(),
    after: workflowRunCursorSchema.optional(),
    workflowId: z.uuid().optional(),
    status: workflowRunStatusSchema.optional(),
    createdAtFrom: workflowRunCreatedAtSchema.optional(),
    createdAtBefore: workflowRunCreatedAtSchema.optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      query.createdAtFrom !== undefined &&
      query.createdAtBefore !== undefined &&
      query.createdAtFrom >= query.createdAtBefore
    ) {
      context.addIssue({
        code: 'custom',
        path: ['createdAtBefore'],
        message: 'createdAtBefore must be later than createdAtFrom',
      });
    }
  });

export const workflowRunListResponseSchema = z
  .object({
    items: z.array(workflowRunSummarySchema).max(100),
    nextCursor: workflowRunCursorSchema.nullable(),
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
export type WorkflowRunListQuery = z.output<typeof workflowRunListQuerySchema>;
export type WorkflowRunListResponse = z.output<
  typeof workflowRunListResponseSchema
>;
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
