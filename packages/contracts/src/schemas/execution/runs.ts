import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';
import {
  codeDiagnosticsSchema,
  runValueKeySchema,
  runValueTextSchema,
  runValuesSchema,
} from '@pertexo/node-sdk';
import { z } from 'zod';
import { workflowNameSchema } from '../workflows/authoring.js';
import {
  workflowRecoverySummarySchema,
  workflowNodeReuseSchema,
} from './recovery.js';

export * from './step-history.js';
export * from './recovery.js';

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
  'test',
  'api',
  'manual',
  'replay',
  'schedule',
  'webhook',
  'workflow_call',
  'workflow_error',
  'form',
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
  const { whole, fraction, offset } = match.groups;
  if (whole === undefined || offset === undefined)
    throw new TypeError('workflow run timestamp is invalid');
  const epochMilliseconds = Date.parse(`${whole}.000${offset}`);
  const utcWhole = new Date(epochMilliseconds).toISOString().slice(0, 19);
  return `${utcWhole}.${(fraction ?? '').padEnd(6, '0')}Z`;
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
    expectedPublishedVersionId: z.uuid().optional(),
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
    hasHumanTasks: z.boolean().optional(),
    runValues: runValuesSchema.optional(),
    humanWait: z
      .object({
        since: z.iso.datetime(),
        remainingExecutionMs: z
          .number()
          .int()
          .positive()
          .max(3600000)
          .nullable(),
        absoluteDeadlineAt: z.iso.datetime().nullable(),
      })
      .strict()
      .optional(),
    recovery: workflowRecoverySummarySchema.optional(),
    handledFailureCount: z.number().int().min(0).max(200).optional(),
  })
  .strict();

export const workflowRunAdmissionBlockersSchema = z
  .object({
    asOf: z.iso.datetime({ precision: 6 }),
    reasons: z
      .array(
        z.enum(['workspace_capacity', 'workflow_capacity', 'workflow_order']),
      )
      .max(3)
      .readonly(),
  })
  .strict();

export const workflowRunReadSummarySchema = workflowRunSummarySchema
  .extend({
    workflowName: workflowNameSchema.nullable().optional(),
    /** The run a replay was started from (ADR 050). */
    replaySourceRunId: workflowRunIdentifierSchema.nullable().optional(),
    admissionBlockers: workflowRunAdmissionBlockersSchema.optional(),
    /** The run's next step passed its time and no worker has acted on it yet. */
    stalled: z
      .object({ since: z.iso.datetime({ offset: true }) })
      .strict()
      .optional(),
  })
  .strict();

/** The step that explains an unsuccessful run, for run lists (ADR 050). */
export const workflowRunFailedStepSchema = z
  .object({
    nodeId: z.string().min(1).max(256),
    /** The step's own name in the run's version, when it has one. */
    label: z.string().min(1).max(200).nullable(),
    definitionKey: z.string().min(1).max(256).nullable(),
    safeErrorCode: z.string().min(1).max(128).nullable(),
  })
  .strict();

export const workflowRunListItemSchema = workflowRunReadSummarySchema
  .extend({ failedStep: workflowRunFailedStepSchema.nullable().optional() })
  .strict();

export const workflowRunListQuerySchema = z
  .object({
    limit: workflowRunPageLimitSchema.optional(),
    after: workflowRunCursorSchema.optional(),
    workflowId: z.uuid().optional(),
    runValueKey: runValueKeySchema.optional(),
    runValue: runValueTextSchema.optional(),
    workflowNamePrefix: workflowNameSchema.optional(),
    status: workflowRunStatusSchema.optional(),
    createdAtFrom: workflowRunCreatedAtSchema.optional(),
    createdAtBefore: workflowRunCreatedAtSchema.optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if ((query.runValueKey === undefined) !== (query.runValue === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['runValue'],
        message: 'Provide both the run value key and its exact text value.',
      });
    }
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
    items: z.array(workflowRunListItemSchema).max(100),
    nextCursor: workflowRunCursorSchema.nullable(),
  })
  .strict();

/** Fixed statistics windows; every one lies well inside run retention. */
export const workflowRunStatisticsWindowSchema = z.enum([
  '1h',
  '6h',
  '24h',
  '7d',
]);
export const workflowRunStatisticsBreakdownSchema = z.enum(['workflow']);
/** Workflows returned by a per-workflow breakdown, busiest first. */
export const WORKFLOW_RUN_STATISTICS_WORKFLOW_LIMIT = 50;

export const workflowRunStatisticsQuerySchema = z
  .object({
    window: workflowRunStatisticsWindowSchema.optional(),
    breakdown: workflowRunStatisticsBreakdownSchema.optional(),
  })
  .strict();

const workflowRunCountSchema = z.number().int().nonnegative();
const workflowRunStatisticsTimestampSchema = z.iso.datetime({ precision: 6 });

/** Exact PostgreSQL bigint bytes; never rounded through a JSON number. */
const capacityBytesSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/u);
const capacityCountSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

/** ADR057: operational capacity is separate from retained run activity. */
export const usageCapacityResponseSchema = z
  .object({
    asOf: workflowRunStatisticsTimestampSchema,
    execution: z
      .object({
        activeRuns: capacityCountSchema,
        reservedActiveSlots: capacityCountSchema,
        activeCapacityConsumed: capacityCountSchema,
        queuedRuns: capacityCountSchema,
        policy: z
          .object({
            state: z.enum([
              'active',
              'suspended',
              'not_yet_effective',
              'expired',
              'unavailable',
            ]),
            version: z.number().int().positive().nullable(),
            activeRunLimit: z.number().int().min(1).max(10_000).nullable(),
            queuedRunLimit: z.number().int().min(1).max(100_000).nullable(),
          })
          .strict(),
      })
      .strict(),
    artifacts: z
      .object({
        chargedBytes: capacityBytesSchema,
        byteLimit: capacityBytesSchema,
        chargedCount: capacityCountSchema,
        artifactCountLimit: capacityCountSchema,
        source: z.enum(['stored', 'default']),
      })
      .strict(),
  })
  .strict();

export type UsageCapacityResponse = z.infer<typeof usageCapacityResponseSchema>;

/** One exact count per run status. */
const workflowRunStatusCountsSchema = z
  .object({
    queued: workflowRunCountSchema,
    running: workflowRunCountSchema,
    waiting: workflowRunCountSchema,
    succeeded: workflowRunCountSchema,
    failed: workflowRunCountSchema,
    canceled: workflowRunCountSchema,
    timed_out: workflowRunCountSchema,
    outcome_unknown: workflowRunCountSchema,
  })
  .strict();

/** Runs that are not finished yet, whenever they were created. */
const workflowRunCurrentCountsSchema = workflowRunStatusCountsSchema
  .pick({ queued: true, running: true, waiting: true })
  .strict();

const workflowRunWorkflowStatisticsSchema = z
  .object({
    workflowId: z.uuid(),
    workflowName: workflowNameSchema.nullable().optional(),
    total: workflowRunCountSchema,
    byStatus: workflowRunStatusCountsSchema,
  })
  .strict();

export const workflowRunStatisticsResponseSchema = z
  .object({
    asOf: workflowRunStatisticsTimestampSchema,
    current: workflowRunCurrentCountsSchema,
    window: z
      .object({
        duration: workflowRunStatisticsWindowSchema,
        createdAtFrom: workflowRunStatisticsTimestampSchema,
        createdAtBefore: workflowRunStatisticsTimestampSchema,
        total: workflowRunCountSchema,
        skippedTriggerEvents: workflowRunCountSchema.optional(),
        coordinatedTriggerEvents: workflowRunCountSchema.optional(),
        byStatus: workflowRunStatusCountsSchema,
      })
      .strict(),
    workflows: z
      .object({
        items: z
          .array(workflowRunWorkflowStatisticsSchema)
          .max(WORKFLOW_RUN_STATISTICS_WORKFLOW_LIMIT),
        truncated: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const workflowNodeRunSummarySchema = z
  .object({
    id: z.uuid(),
    nodeId: z.string().min(1).max(256),
    invocationKey: z.string().min(1).max(1_024),
    status: workflowNodeRunStatusSchema,
    currentAttemptNumber: z.number().int().nonnegative(),
    reused: workflowNodeReuseSchema.optional(),
    failureHandling: z
      .object({
        entryInvocationKey: z.string().min(1).max(256),
        sinkInvocationKey: z.string().min(1).max(256),
        disposition: z.enum(['pending', 'handled']),
      })
      .strict()
      .optional(),
    startedAt: z.iso.datetime({ offset: true }).nullable(),
    completedAt: z.iso.datetime({ offset: true }).nullable(),
    resumeAt: z.iso.datetime({ offset: true }).nullable(),
    errorSummary: z.string().max(2048).nullable().optional(),
    safeErrorCode: z.string().min(1).max(128).nullable(),
  })
  .strict();

export const workflowNodeRunParamsSchema = z
  .object({
    workspaceId: z.uuid(),
    runId: workflowRunIdentifierSchema,
    nodeRunId: z.uuid(),
  })
  .strict();

/**
 * A run's input or a step's output as stored (ADR 050): inline JSON, a file,
 * nothing, or an input no longer kept after its 30-day window.
 */
export const workflowRunDataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline'), value: z.json() }).strict(),
  z.object({ kind: z.literal('artifact'), artifactId: z.uuid() }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('expired') }).strict(),
]);
export const workflowRunInputResponseSchema = z
  .object({ input: workflowRunDataSchema })
  .strict();
export const workflowNodeRunOutputResponseSchema = z
  .object({ output: workflowRunDataSchema })
  .strict();
/** What one step run received, when it was recorded (ADR 052). */
export const workflowNodeRunInputResponseSchema = z
  .object({ input: workflowRunDataSchema })
  .strict();

export const workflowRunStartResponseSchema = z
  .object({ run: workflowRunSummarySchema, replayed: z.boolean() })
  .strict();
/** A logical Call's retained identity, without mapped input or result payloads. */
const workflowCallSummarySchema = z
  .object({
    id: z.uuid(),
    invocationKey: z.string().min(1).max(256),
    targetWorkflowId: z.uuid(),
    targetVersionId: z.uuid(),
    childRunId: z.uuid().nullable(),
    childHistory: z.enum(['not_started', 'retained', 'expired', 'unavailable']),
    status: z.enum([
      'pending',
      'accepted',
      'refused',
      'succeeded',
      'failed',
      'canceled',
      'timed_out',
      'outcome_unknown',
    ]),
    slotLent: z.boolean(),
    detailsRetired: z.boolean(),
    safeErrorCode: z.string().min(1).max(128).nullable(),
  })
  .strict();
const workflowParentCallSchema = z
  .object({
    id: z.uuid(),
    parentRunId: z.uuid(),
    invocationKey: z.string().min(1).max(256),
  })
  .strict();
export type WorkflowCallSummary = z.output<typeof workflowCallSummarySchema>;
export type WorkflowParentCall = z.output<typeof workflowParentCallSchema>;

export const workflowRunErrorWorkflowSchema = z
  .object({
    status: z.enum(['pending', 'accepted', 'refused']),
    targetWorkflowId: z.uuid(),
    targetVersionId: z.uuid().nullable(),
    acceptedRunId: z.uuid().nullable(),
    queueWaitExpiresAt: z.iso.datetime().nullable().default(null),
    refusalCode: z
      .enum([
        'target_unavailable',
        'target_not_published',
        'workspace_unavailable',
        'queue_full',
        'concurrency_limit',
        'invalid_target',
      ])
      .nullable(),
  })
  .strict();
export type WorkflowRunErrorWorkflow = z.infer<
  typeof workflowRunErrorWorkflowSchema
>;

export const workflowRunResponseSchema = z
  .object({
    run: workflowRunReadSummarySchema,
    nodes: z
      .array(workflowNodeRunSummarySchema)
      .max(WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations),
    calls: z
      .array(workflowCallSummarySchema)
      .max(WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations)
      .optional(),
    parentCall: workflowParentCallSchema.optional(),
    errorWorkflow: workflowRunErrorWorkflowSchema.optional(),
  })
  .strict();
export const workflowRunCancelResponseSchema = z
  .object({ run: workflowRunSummarySchema, alreadyRequested: z.boolean() })
  .strict();

const workflowRunEventTypeSchema = z.enum([
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
  'node.reused',
  'node.failure_routed',
  'node.failure_handled',
  'node.failed',
  'node.skipped',
  'node.canceled',
  'node.timed_out',
  'node.outcome_unknown',
]);
const workflowRunOutputReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reused'), nodeRunId: z.uuid() }).strict(),
  z.object({ kind: z.literal('call'), callId: z.uuid() }).strict(),
  z.object({ kind: z.literal('inline'), attemptId: z.uuid() }).strict(),
  z.object({ kind: z.literal('artifact'), artifactId: z.uuid() }).strict(),
]);
export const workflowRunEventPayloadSchema = z
  .object({
    invocationKey: z.string().min(1).max(1_024).optional(),
    nodeId: z.string().min(1).max(256).optional(),
    nodeRunId: z.uuid().optional(),
    attemptId: z.uuid().optional(),
    sourceRunId: z.uuid().optional(),
    sourceNodeRunId: z.uuid().optional(),
    sourceCompletedAt: z.iso.datetime({ offset: true }).optional(),
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
export type WorkflowRunReadSummary = z.output<
  typeof workflowRunReadSummarySchema
>;
export type WorkflowRunListQuery = z.output<typeof workflowRunListQuerySchema>;
export type WorkflowRunListItem = z.output<typeof workflowRunListItemSchema>;
export type WorkflowRunFailedStep = z.output<
  typeof workflowRunFailedStepSchema
>;
export type WorkflowRunData = z.output<typeof workflowRunDataSchema>;
export type WorkflowRunInputResponse = z.output<
  typeof workflowRunInputResponseSchema
>;
export type WorkflowNodeRunOutputResponse = z.output<
  typeof workflowNodeRunOutputResponseSchema
>;
export type WorkflowNodeRunInputResponse = z.output<
  typeof workflowNodeRunInputResponseSchema
>;
export type WorkflowRunListResponse = z.output<
  typeof workflowRunListResponseSchema
>;
export type WorkflowRunStatisticsWindow = z.output<
  typeof workflowRunStatisticsWindowSchema
>;
export type WorkflowRunStatisticsQuery = z.output<
  typeof workflowRunStatisticsQuerySchema
>;
export type WorkflowRunStatisticsResponse = z.output<
  typeof workflowRunStatisticsResponseSchema
>;
export type WorkflowNodeRunSummary = z.output<
  typeof workflowNodeRunSummarySchema
>;
export type WorkflowRunEvent = z.output<typeof workflowRunEventSchema>;
export type WorkflowRunStartResponse = z.output<
  typeof workflowRunStartResponseSchema
>;
export type WorkflowRunResponse = z.output<typeof workflowRunResponseSchema>;
export type WorkflowRunCancelResponse = z.output<
  typeof workflowRunCancelResponseSchema
>;

export const workflowNodeRunDiagnosticsResponseSchema = z
  .object({ diagnostics: codeDiagnosticsSchema.nullable() })
  .strict();
export type WorkflowNodeRunDiagnosticsResponse = z.output<
  typeof workflowNodeRunDiagnosticsResponseSchema
>;
