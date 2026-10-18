import { z } from 'zod';
import { workflowGraphSchema } from '@pertexo/workflow-model';
import {
  PROMOTION_LIMITS,
  promotionIdentifierSchema as id,
} from './settings.js';

export const workflowPromotionModeSchema = z.enum([
  'draft',
  'publish',
  'request_approval',
]);
const selection = z.object({ workflowId: id, versionId: id }).strict();
export const workflowPromotionPreviewRequestSchema = z
  .object({
    selections: z
      .array(selection)
      .min(1)
      .max(PROMOTION_LIMITS.workflows)
      .refine(
        (items) =>
          new Set(items.map((item) => item.workflowId)).size === items.length,
        'Choose one version per workflow.',
      ),
    mode: workflowPromotionModeSchema.default('draft'),
  })
  .strict();
export const workflowPromotionRequirementSchema = z
  .object({
    workflowId: id,
    nodeId: z.string().max(128).optional(),
    kind: z.enum([
      'connection',
      'variable',
      'table',
      'column',
      'call',
      'file',
      'validation',
      'name',
    ]),
    status: z.enum(['ready', 'missing', 'incompatible', 'warning']),
    name: z.string().max(256),
    detail: z.string().max(512),
    dependency: selection.optional(),
    targetVersionId: id.optional(),
  })
  .strict();
export const workflowPromotionPreviewSchema = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceWorkspaceId: id,
    sourceWorkspaceName: z.string().max(128),
    targetWorkspaceId: id,
    targetWorkspaceName: z.string().max(128),
    mode: workflowPromotionModeSchema,
    requireApproval: z.boolean(),
    compatible: z.boolean(),
    workflows: z
      .array(
        z
          .object({
            sourceWorkflowId: id,
            sourceName: z.string().max(128),
            sourceVersionId: id,
            sourceVersionNumber: z.number().int().positive(),
            sourceChecksum: z.string().regex(/^wf:sha256:[a-f0-9]{64}$/u),
            targetWorkflowId: id.nullable(),
            targetName: z.string().max(128),
            targetRevision: z.number().int().positive().nullable(),
            targetPublishedVersionId: id.nullable(),
            directChanges: z.boolean(),
            proposedGraph: workflowGraphSchema,
            targetGraph: workflowGraphSchema.nullable(),
          })
          .strict(),
      )
      .max(PROMOTION_LIMITS.workflows),
    requirements: z
      .array(workflowPromotionRequirementSchema)
      .max(PROMOTION_LIMITS.requirements),
  })
  .strict();
export type WorkflowPromotionMode = z.output<
  typeof workflowPromotionModeSchema
>;
export type WorkflowPromotionPreviewRequest = z.output<
  typeof workflowPromotionPreviewRequestSchema
>;
export type WorkflowPromotionRequirement = z.output<
  typeof workflowPromotionRequirementSchema
>;
export type WorkflowPromotionPreview = z.output<
  typeof workflowPromotionPreviewSchema
>;
