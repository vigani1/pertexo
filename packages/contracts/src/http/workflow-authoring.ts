import { z } from 'zod';
import {
  workflowGraphSchema,
  type WorkflowGraph,
} from '@pertexo/workflow-model/graph-contract';

import {
  apiProblemIssueSchema,
  createApiProblemSchema,
} from '../errors/api-problem.js';

/** Opaque, quoted strong HTTP entity tag. Its internal value is not a client contract. */
export const strongEtagSchema = z
  .string()
  .regex(/^"draft-v1\.[A-Za-z0-9_-]{43}"$/u);
export const ifMatchHeaderSchema = strongEtagSchema;
export const workflowIdentifierSchema = z.uuid();
export const workflowIdParamSchema = z
  .object({ workspaceId: z.uuid(), workflowId: workflowIdentifierSchema })
  .strict();
export const workflowNodeIdParamSchema = z
  .object({
    workspaceId: z.uuid(),
    workflowId: workflowIdentifierSchema,
    nodeId: z.string().min(1).max(256),
  })
  .strict();
export const workflowCursorSchema = z.string().min(1).max(512);
export const workflowPageLimitSchema = z.coerce.number().int().min(1).max(100);

const positiveVersionSchema = z.number().int().positive();
export { workflowGraphSchema };
export type WorkflowGraphContract = WorkflowGraph;

export const workflowCreateRequestSchema = z
  .object({ name: z.string().trim().min(1).max(128) })
  .strict();

export const workflowLifecycleStatusSchema = z.enum(['active', 'archived']);
export const workflowActivationStatusSchema = z.literal('inactive');
export const workflowCompatibilityIssueSchema = z
  .object({
    code: z.literal('unknown_definition'),
    definitionKey: z.string().min(1).max(256),
    version: positiveVersionSchema,
  })
  .strict();
export const workflowCompatibilityReportSchema = z
  .object({
    compatible: z.boolean(),
    fingerprint: z.string().regex(/^wf-compat:v1:sha256:[0-9a-f]{64}$/u),
    issues: z.array(workflowCompatibilityIssueSchema).max(1_000),
  })
  .strict();
export const workflowValidationIssueSchema = apiProblemIssueSchema;
export const workflowValidationReportSchema = z
  .object({
    valid: z.boolean(),
    issues: z.array(workflowValidationIssueSchema).max(100),
    compatibility: workflowCompatibilityReportSchema,
  })
  .strict();

export const workflowSummarySchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    name: z.string(),
    lifecycleStatus: workflowLifecycleStatusSchema,
    activationStatus: workflowActivationStatusSchema,
    publishedVersionId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const workflowResponseSchema = workflowSummarySchema;

export const workflowDraftResponseSchema = z
  .object({
    workflowId: workflowIdentifierSchema,
    revision: z.number().int().positive(),
    schemaVersion: z.literal(1),
    graph: workflowGraphSchema,
    compatibility: workflowCompatibilityReportSchema,
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const workflowDraftSchema = workflowDraftResponseSchema;
export const workflowDraftSaveRequestSchema = z
  .object({ graph: workflowGraphSchema })
  .strict();
export const workflowValidateResponseSchema = workflowValidationReportSchema;
export const workflowValidationResponseSchema = workflowValidationReportSchema;

export const workflowVersionResponseSchema = z
  .object({
    id: z.uuid(),
    workflowId: z.uuid(),
    versionNumber: z.number().int().positive(),
    schemaVersion: z.literal(1),
    graph: workflowGraphSchema,
    checksum: z.string().regex(/^wf:v1:sha256:[0-9a-f]{64}$/u),
    publishedAt: z.iso.datetime(),
  })
  .strict();
export const workflowVersionSchema = workflowVersionResponseSchema;
export const workflowPublishResponseSchema = z
  .object({
    version: workflowVersionResponseSchema,
    reused: z.boolean(),
  })
  .strict();
export const workflowVersionsResponseSchema = z
  .object({
    items: z.array(workflowVersionResponseSchema).max(100),
    nextCursor: workflowCursorSchema.nullable(),
  })
  .strict();
export const workflowVersionListResponseSchema = workflowVersionsResponseSchema;
export const workflowListResponseSchema = z
  .object({
    items: z.array(workflowSummarySchema).max(100),
    nextCursor: workflowCursorSchema.nullable(),
  })
  .strict();
export const workflowCreateResponseSchema = z
  .object({
    workflow: workflowSummarySchema,
    draft: workflowDraftResponseSchema,
  })
  .strict();

export const workflowListQuerySchema = z
  .object({
    limit: workflowPageLimitSchema.optional(),
    after: workflowCursorSchema.optional(),
  })
  .strict();
export const workflowVersionsQuerySchema = workflowListQuerySchema;

export const workflowRevisionConflictProblemSchema = createApiProblemSchema({
  status: z.literal(412),
  code: z.literal('workflow.revision_conflict'),
  currentRevision: z.number().int().positive(),
  currentEtag: strongEtagSchema,
});

export type WorkflowSummary = z.output<typeof workflowSummarySchema>;
export type WorkflowCreateResponse = z.output<
  typeof workflowCreateResponseSchema
>;
export type WorkflowDraftResponse = z.output<
  typeof workflowDraftResponseSchema
>;
export type WorkflowPublishResponse = z.output<
  typeof workflowPublishResponseSchema
>;
export type WorkflowRevisionConflictProblem = z.output<
  typeof workflowRevisionConflictProblemSchema
>;
