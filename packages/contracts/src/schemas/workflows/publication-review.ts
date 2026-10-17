import { z } from 'zod';
import { workflowGraphSchema } from '@pertexo/workflow-model';

export const publicationReviewRequestSchema = z
  .object({ note: z.string().trim().min(1).max(1000) })
  .strict();
export const publicationReviewDecisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    comment: z.string().trim().max(1000).optional(),
  })
  .strict();
export const publicationReviewParamsSchema = z
  .object({ workspaceId: z.uuid(), requestId: z.uuid() })
  .strict();
export const publicationReviewSchema = z
  .object({
    id: z.uuid(),
    workflowId: z.uuid(),
    workflowName: z.string().max(128),
    requestedBy: z.uuid(),
    requesterName: z.string().max(256),
    draftRevision: z.number().int().positive(),
    note: z.string().max(1000),
    status: z.enum(['pending', 'approved', 'rejected', 'stale', 'expired']),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    decidedBy: z.uuid().nullable(),
    deciderName: z.string().max(256).nullable(),
    decidedAt: z.iso.datetime().nullable(),
    comment: z.string().max(1000).nullable(),
    publishedVersionId: z.uuid().nullable(),
    versionNumber: z.number().int().positive().nullable(),
    canDecide: z.boolean(),
  })
  .strict();
export const publicationReviewOverviewSchema = z
  .object({
    required: z.boolean(),
    request: publicationReviewSchema.nullable(),
  })
  .strict();
export const publicationReviewDetailSchema = z
  .object({
    request: publicationReviewSchema,
    graph: workflowGraphSchema.nullable(),
    liveGraph: workflowGraphSchema.nullable(),
  })
  .strict();
export type PublicationReview = z.output<typeof publicationReviewSchema>;
export type PublicationReviewOverview = z.output<
  typeof publicationReviewOverviewSchema
>;
export type PublicationReviewDetail = z.output<
  typeof publicationReviewDetailSchema
>;
export type PublicationReviewDecision = z.output<
  typeof publicationReviewDecisionSchema
>;
