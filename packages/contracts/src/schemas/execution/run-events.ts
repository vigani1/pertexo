import { z } from 'zod';

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
export type WorkflowRunEvent = z.output<typeof workflowRunEventSchema>;
