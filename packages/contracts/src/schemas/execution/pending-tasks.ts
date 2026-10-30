import {
  workspacePeopleQuerySchema as approvalAudienceQuerySchema,
  workspacePeoplePageSchema as approvalAudiencePageSchema,
} from '../identity/people.js';
export { approvalAudienceQuerySchema, approvalAudiencePageSchema };
import { z } from 'zod';
import {
  taskAudienceSchema,
  approvalDecisionSchema,
  approvalOutputSchema,
  formFieldsSchema,
  formSubmissionSchema,
  PENDING_TASK_LIMITS,
  taskDetailsSchema,
  taskContextSchema,
  taskExpiryChoiceSchema,
} from '@pertexo/workflow-model';

export const pendingTaskParamsSchema = z
  .object({ workspaceId: z.uuid(), taskId: z.uuid() })
  .strict();
export const pendingTaskListQuerySchema = z
  .object({
    after: z.uuid().optional(),
    kind: z.enum(['all', 'approval', 'input_request']).optional(),
    runId: z.uuid().optional(),
    view: z.enum(['mine', 'all']).default('mine'),
    status: z.enum(['pending', 'resolved', 'all']).default('pending'),
  })
  .strict();
const pendingTaskStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'submitted',
  'expired',
  'refused',
  'canceled',
]);
export const pendingTaskSummarySchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    workflowId: z.uuid(),
    workflowName: z.string().max(128),
    runId: z.uuid(),
    nodeId: z.string().max(128),
    nodeRunId: z.uuid(),
    iterationPath: z
      .array(
        z
          .object({
            loopNodeId: z.string().min(1).max(128),
            ordinal: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(64),
    kind: z.enum(['approval', 'input_request']),
    title: z.string().max(PENDING_TASK_LIMITS.titleCharacters),
    details: taskDetailsSchema.default({}),
    status: pendingTaskStatusSchema,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    onExpiry: taskExpiryChoiceSchema,
    completedAt: z.iso.datetime().nullable(),
    completedByName: z.string().max(256).nullable(),
    canRespond: z.boolean(),
    blockedReason: z
      .enum([
        'starter',
        'audience',
        'expired',
        'resolved',
        'run_closed',
        'workspace_suspended',
      ])
      .nullable(),
  })
  .strict();
const taskDetailBase = pendingTaskSummarySchema.extend({
  workflowVersionId: z.uuid(),
  instructions: z.string().max(PENDING_TASK_LIMITS.instructionsCharacters),
  audience: taskAudienceSchema,
});
export const pendingTaskDetailSchema = z.discriminatedUnion('kind', [
  taskDetailBase
    .extend({
      kind: z.literal('approval'),
      output: approvalOutputSchema.nullable(),
    })
    .strict(),
  taskDetailBase
    .extend({
      kind: z.literal('input_request'),
      fields: formFieldsSchema,
      prefill: taskContextSchema.shape.prefill.default({}),
      output: formSubmissionSchema.nullable(),
    })
    .strict(),
]);
export const pendingTaskSubmitRequestSchema = z
  .object({ values: z.record(z.string(), z.unknown()) })
  .strict();
export type PendingTaskSubmitRequest = z.output<
  typeof pendingTaskSubmitRequestSchema
>;
export const pendingTaskResponseSchema = z
  .object({ task: pendingTaskDetailSchema })
  .strict();
export const pendingTaskListResponseSchema = z
  .object({
    items: z.array(pendingTaskSummarySchema).max(50),
    nextCursor: z.uuid().nullable(),
    pendingCount: z.number().int().nonnegative(),
  })
  .strict();
export const pendingTaskDecisionRequestSchema = z
  .object({
    decision: approvalDecisionSchema,
    comment: z
      .string()
      .trim()
      .max(PENDING_TASK_LIMITS.commentCharacters)
      .optional(),
  })
  .strict();
export const pendingTaskDecisionResponseSchema = z
  .object({ task: pendingTaskDetailSchema, replayed: z.boolean() })
  .strict();
export type PendingTaskSummary = z.output<typeof pendingTaskSummarySchema>;
export type PendingTaskDetail = z.output<typeof pendingTaskDetailSchema>;
export type PendingTaskListQuery = z.output<typeof pendingTaskListQuerySchema>;
export type PendingTaskListResponse = z.output<
  typeof pendingTaskListResponseSchema
>;
export type PendingTaskDecisionRequest = z.output<
  typeof pendingTaskDecisionRequestSchema
>;
export type PendingTaskDecisionResponse = z.output<
  typeof pendingTaskDecisionResponseSchema
>;
export type ApprovalAudienceQuery = z.output<
  typeof approvalAudienceQuerySchema
>;
export type ApprovalAudiencePage = z.output<typeof approvalAudiencePageSchema>;

export const approvalAudienceInspectionRequestSchema = z
  .object({ audience: taskAudienceSchema })
  .strict();
export const approvalAudienceInspectionResponseSchema = z
  .object({
    matchingMemberCount: z.number().int().nonnegative(),
    actorMatchesAudience: z.boolean(),
  })
  .strict();
export type ApprovalAudienceInspectionRequest = z.output<
  typeof approvalAudienceInspectionRequestSchema
>;
export type ApprovalAudienceInspectionResponse = z.output<
  typeof approvalAudienceInspectionResponseSchema
>;
