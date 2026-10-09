import { z } from 'zod';

// A step's record across its workflow's last 100 runs (ADR 051).

/** How many of a workflow's newest runs step history looks at. */
const STEP_HISTORY_RUN_WINDOW = 100;

const stepIdentifierSchema = z.string().min(1).max(256);
const countSchema = z.number().int().nonnegative();
const timestampSchema = z.iso.datetime({ offset: true });
const nodeRunStatusSchema = z.enum([
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
const runStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);

export const workflowStepHealthParamsSchema = z
  .object({ workspaceId: z.uuid(), workflowId: z.uuid() })
  .strict();
export const workflowStepRunsParamsSchema = workflowStepHealthParamsSchema
  .extend({ nodeId: stepIdentifierSchema })
  .strict();
export const workflowStepRunsQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(50).optional() })
  .strict();

/** One step's record in the window: how often, how it ended, how long. */
export const workflowStepHealthSchema = z
  .object({
    nodeId: stepIdentifierSchema,
    /** Times it ran; a step inside a loop runs once per item. */
    runs: countSchema,
    succeeded: countSchema,
    /** Failed, timed out or ended with an unknown outcome. */
    failed: countSchema,
    skipped: countSchema,
    lastStatus: nodeRunStatusSchema,
    lastRanAt: timestampSchema,
    /** Of its successful runs, in milliseconds; null without one. */
    medianDurationMs: z.number().int().nonnegative().nullable(),
    p95DurationMs: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const workflowStepHealthResponseSchema = z
  .object({
    runsConsidered: z.number().int().min(0).max(STEP_HISTORY_RUN_WINDOW),
    /** When the oldest run in the window started; null without runs. */
    oldestRunAt: timestampSchema.nullable(),
    items: z.array(workflowStepHealthSchema).max(1_000),
  })
  .strict();

/** One run of one step, with the run it belongs to. */
export const workflowStepRunSchema = z
  .object({
    runId: z.uuid(),
    runStatus: runStatusSchema,
    runCreatedAt: timestampSchema,
    workflowVersionId: z.uuid(),
    nodeRunId: z.uuid(),
    invocationKey: z.string().min(1).max(1_024),
    status: nodeRunStatusSchema,
    attempts: countSchema,
    startedAt: timestampSchema.nullable(),
    completedAt: timestampSchema.nullable(),
    safeErrorCode: z.string().min(1).max(128).nullable(),
  })
  .strict();

export const workflowStepRunsResponseSchema = z
  .object({ items: z.array(workflowStepRunSchema).max(50) })
  .strict();

export type WorkflowStepHealth = z.output<typeof workflowStepHealthSchema>;
export type WorkflowStepHealthResponse = z.output<
  typeof workflowStepHealthResponseSchema
>;
export type WorkflowStepRun = z.output<typeof workflowStepRunSchema>;
export type WorkflowStepRunsResponse = z.output<
  typeof workflowStepRunsResponseSchema
>;
