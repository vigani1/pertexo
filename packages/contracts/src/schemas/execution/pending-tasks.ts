import { z } from 'zod';
import {
  taskAudienceSchema,
  approvalDecisionSchema,
  approvalOutputSchema,
  PENDING_TASK_LIMITS,
} from '@pertexo/workflow-model';

export const pendingTaskParamsSchema = z
  .object({ workspaceId: z.uuid(), taskId: z.uuid() })
  .strict();
export const pendingTaskListQuerySchema = z
  .object({
    after: z.uuid().optional(),
    runId: z.uuid().optional(),
    view: z.enum(['mine', 'all']).default('mine'),
    status: z.enum(['pending', 'resolved', 'all']).default('pending'),
  })
  .strict();
const pendingTaskStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
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
    kind: z.literal('approval'),
    title: z.string().max(PENDING_TASK_LIMITS.titleCharacters),
    status: pendingTaskStatusSchema,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    decidedByName: z.string().max(256).nullable(),
    canDecide: z.boolean(),
    blockedReason: z
      .enum(['starter', 'audience', 'expired', 'resolved', 'run_closed'])
      .nullable(),
  })
  .strict();
export const pendingTaskDetailSchema = pendingTaskSummarySchema
  .extend({
    workflowVersionId: z.uuid(),
    instructions: z.string().max(PENDING_TASK_LIMITS.instructionsCharacters),
    audience: taskAudienceSchema,
    output: approvalOutputSchema.nullable(),
  })
  .strict();
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
export const approvalAudienceQuerySchema = z
  .object({
    after: z.uuid().optional(),
    q: z.string().trim().max(100).default(''),
  })
  .strict();
export const approvalAudiencePageSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            userId: z.uuid(),
            displayName: z.string().max(256),
            role: z.enum(['owner', 'admin', 'builder', 'operator', 'viewer']),
          })
          .strict(),
      )
      .max(50),
    nextCursor: z.uuid().nullable(),
  })
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
