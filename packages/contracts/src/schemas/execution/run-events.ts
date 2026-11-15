import { WORKFLOW_GRAPH_CONTRACT_LIMITS } from '@pertexo/workflow-model';
import { NODE_FAILURE_FIELD_LIMITS } from '@pertexo/node-sdk';
import { z } from 'zod';

const RUN_EVENTS_BOUNDS = Object.freeze({
  invocationKeyCharacters: WORKFLOW_GRAPH_CONTRACT_LIMITS.invocationKeyLength,
  nodeIdCharacters: WORKFLOW_GRAPH_CONTRACT_LIMITS.identifierLength,
  safeErrorCodeCharacters: NODE_FAILURE_FIELD_LIMITS.safeErrorCodeCharacters,
  reasonCodeCharacters: 128,
});

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
    invocationKey: z
      .string()
      .min(1)
      .max(RUN_EVENTS_BOUNDS.invocationKeyCharacters)
      .optional(),
    nodeId: z
      .string()
      .min(1)
      .max(RUN_EVENTS_BOUNDS.nodeIdCharacters)
      .optional(),
    nodeRunId: z.uuid().optional(),
    attemptId: z.uuid().optional(),
    sourceRunId: z.uuid().optional(),
    sourceNodeRunId: z.uuid().optional(),
    sourceCompletedAt: z.iso.datetime({ offset: true }).optional(),
    attemptNumber: z.number().int().nonnegative().optional(),
    dueAt: z.iso.datetime({ offset: true }).optional(),
    safeErrorCode: z
      .string()
      .min(1)
      .max(RUN_EVENTS_BOUNDS.safeErrorCodeCharacters)
      .optional(),
    reasonCode: z
      .string()
      .min(1)
      .max(RUN_EVENTS_BOUNDS.reasonCodeCharacters)
      .optional(),
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
