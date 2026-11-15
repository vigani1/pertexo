import { RESOURCE_NAME_MAX_LENGTH } from '@pertexo/workflow-model';
import { responseSchema } from '../../shared/response-schema.js';
import { workflowExecutableChecksumSchema } from '@pertexo/workflow-model';
import { z } from 'zod';
import { workflowGraphSchema } from '@pertexo/workflow-model';
import {
  PROMOTION_LIMITS,
  promotionIdentifierSchema as id,
} from './settings.js';

const REVIEW_BOUNDS = Object.freeze({
  nodeIdCharacters: 128,
  nameCharacters: 256,
  detailCharacters: 512,
  sourceWorkspaceNameCharacters: RESOURCE_NAME_MAX_LENGTH,
  targetWorkspaceNameCharacters: RESOURCE_NAME_MAX_LENGTH,
  sourceNameCharacters: RESOURCE_NAME_MAX_LENGTH,
  targetNameCharacters: RESOURCE_NAME_MAX_LENGTH,
});

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
    nodeId: z.string().max(REVIEW_BOUNDS.nodeIdCharacters).optional(),
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
    name: z.string().max(REVIEW_BOUNDS.nameCharacters),
    detail: z.string().max(REVIEW_BOUNDS.detailCharacters),
    dependency: selection.optional(),
    targetVersionId: id.optional(),
  })
  .strict();
export const workflowPromotionPreviewSchema = responseSchema(
  z
    .object({
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
      sourceWorkspaceId: id,
      sourceWorkspaceName: z
        .string()
        .max(REVIEW_BOUNDS.sourceWorkspaceNameCharacters),
      targetWorkspaceId: id,
      targetWorkspaceName: z
        .string()
        .max(REVIEW_BOUNDS.targetWorkspaceNameCharacters),
      mode: workflowPromotionModeSchema,
      requireApproval: z.boolean(),
      compatible: z.boolean(),
      workflows: z
        .array(
          z
            .object({
              sourceWorkflowId: id,
              sourceName: z.string().max(REVIEW_BOUNDS.sourceNameCharacters),
              sourceVersionId: id,
              sourceVersionNumber: z.number().int().positive(),
              sourceChecksum: workflowExecutableChecksumSchema,
              targetWorkflowId: id.nullable(),
              targetName: z.string().max(REVIEW_BOUNDS.targetNameCharacters),
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
    .strict(),
);
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
