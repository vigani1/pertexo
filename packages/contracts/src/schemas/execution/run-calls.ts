import { z } from 'zod';

/** A logical Call's retained identity, without mapped input or result payloads. */
export const workflowCallSummarySchema = z
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
export const workflowParentCallSchema = z
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
