import { responseSchema } from '../shared/response-schema.js';
import { storageTextSchema } from '@pertexo/workflow-model';
import {
  WORKFLOW_GRAPH_LIMITS,
  RUN_STATUSES,
  runFailureCodeSchema,
} from '@pertexo/workflow-model';
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
import {
  workflowCallSummarySchema,
  workflowParentCallSchema,
  workflowRunErrorWorkflowSchema,
} from './run-calls.js';

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

export const workflowRunStatusSchema = z.enum(RUN_STATUSES);
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
const workflowRunPageLimitSchema = z.coerce.number().int().min(1).max(100);
const workflowRunCursorSchema = z.string().min(1).max(1_024);
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

const workflowRunCreatedAtSchema = workflowRunCreatedAtInputSchema.transform(
  normalizeWorkflowRunCreatedAt,
);

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
  .object({ reason: storageTextSchema.trim().min(1).max(500).optional() })
  .strict();

export const workflowRunSummarySchema = responseSchema(
  z
    .object({
      id: workflowRunIdentifierSchema,
      workspaceId: z.uuid(),
      workflowId: z.uuid(),
      workflowVersionId: z.uuid(),
      status: workflowRunStatusSchema,
      failureReasonCode: runFailureCodeSchema.nullable().optional(),
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
    .strict(),
);

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

export const workflowRunReadSummarySchema = responseSchema(
  workflowRunSummarySchema
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
    .strict(),
);

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

export const workflowRunListResponseSchema = responseSchema(
  z
    .object({
      items: z.array(workflowRunListItemSchema).max(100),
      nextCursor: workflowRunCursorSchema.nullable(),
    })
    .strict(),
);

export const workflowNodeRunSummarySchema = responseSchema(
  z
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
    .strict(),
);

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
export const workflowRunInputResponseSchema = responseSchema(
  z.object({ input: workflowRunDataSchema }).strict(),
);
export const workflowNodeRunOutputResponseSchema = responseSchema(
  z.object({ output: workflowRunDataSchema }).strict(),
);
/** What one step run received, when it was recorded (ADR 052). */
export const workflowNodeRunInputResponseSchema = responseSchema(
  z.object({ input: workflowRunDataSchema }).strict(),
);

export const workflowRunStartResponseSchema = responseSchema(
  z.object({ run: workflowRunSummarySchema, replayed: z.boolean() }).strict(),
);

export const workflowRunResponseSchema = responseSchema(
  z
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
    .strict(),
);
export const workflowRunCancelResponseSchema = responseSchema(
  z
    .object({ run: workflowRunSummarySchema, alreadyRequested: z.boolean() })
    .strict(),
);

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
export type WorkflowRunListResponse = z.output<
  typeof workflowRunListResponseSchema
>;
export type WorkflowNodeRunSummary = z.output<
  typeof workflowNodeRunSummarySchema
>;
export type WorkflowRunStartResponse = z.output<
  typeof workflowRunStartResponseSchema
>;
export type WorkflowRunResponse = z.output<typeof workflowRunResponseSchema>;
export type WorkflowRunCancelResponse = z.output<
  typeof workflowRunCancelResponseSchema
>;

export const workflowNodeRunDiagnosticsResponseSchema = responseSchema(
  z.object({ diagnostics: codeDiagnosticsSchema.nullable() }).strict(),
);
export type WorkflowNodeRunDiagnosticsResponse = z.output<
  typeof workflowNodeRunDiagnosticsResponseSchema
>;
