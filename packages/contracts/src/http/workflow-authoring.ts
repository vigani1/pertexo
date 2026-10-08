import { z } from 'zod';
import { workflowTemplateOriginSchema } from '@pertexo/workflow-model/curated-templates';
export type { WorkflowTemplateOrigin } from '@pertexo/workflow-model/curated-templates';
export * from './workflow-auto-pause.js';
export * from './workflow-concurrency.js';
export * from './workflow-organization.js';
export * from './workflow-organization-folders.js';
import { workflowOrganizationFolderFilterSchema } from './workflow-organization-folders.js';
import {
  workflowOrganizationNameQuerySchema,
  workflowOrganizationSchema,
  workflowOrganizationViewSchema,
} from './workflow-organization.js';
import {
  workflowActivationStatusSchema,
  workflowLifecycleStatusSchema,
} from '@pertexo/workflow-model/lifecycle';
import {
  WORKFLOW_VALIDATION_MAX_ISSUES,
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
export const workflowLifecycleRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
/** ADR 041: advances once per effective rename, independent of lifecycle and drafts. */
export const workflowNameRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const workflowIdParamSchema = z
  .object({ workspaceId: z.uuid(), workflowId: workflowIdentifierSchema })
  .strict();
export const workflowVersionRestoreParamsSchema = z
  .object({
    workspaceId: z.uuid(),
    workflowId: workflowIdentifierSchema,
    versionId: workflowIdentifierSchema,
  })
  .strict();
export const workflowVersionRestoreRequestSchema = z.object({}).strict();
export const workflowNodeIdParamSchema = z
  .object({
    workspaceId: z.uuid(),
    workflowId: workflowIdentifierSchema,
    nodeId: z.string().min(1).max(256),
  })
  .strict();
export const workflowCursorSchema = z.string().min(1).max(512);
export const workflowPageLimitSchema = z.coerce.number().int().min(1).max(100);
export const workflowListOrderSchema = z.enum(['created_asc', 'updated_desc']);
export const workflowNameSchema = z.string().trim().min(1).max(128);

const positiveVersionSchema = z.number().int().positive();
export { workflowGraphSchema };
// Browser-safe graph bounds, shared with the structural schema and admission.
export { WORKFLOW_GRAPH_CONTRACT_LIMITS } from '@pertexo/workflow-model/graph-contract';
export type WorkflowGraphContract = WorkflowGraph;

export const workflowCreateRequestSchema = z
  .object({ name: workflowNameSchema })
  .strict();

export const workflowDuplicateSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('draft') }).strict(),
  z
    .object({ kind: z.literal('version'), versionId: workflowIdentifierSchema })
    .strict(),
]);
export const workflowDuplicateRequestSchema = z
  .object({ name: workflowNameSchema, source: workflowDuplicateSourceSchema })
  .strict();
export const workflowDuplicateResponseSchema = z
  .object({ workflowId: workflowIdentifierSchema })
  .strict();
export type WorkflowDuplicateRequest = z.output<
  typeof workflowDuplicateRequestSchema
>;
export type WorkflowDuplicateResponse = z.output<
  typeof workflowDuplicateResponseSchema
>;

export { workflowActivationStatusSchema, workflowLifecycleStatusSchema };
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
    fingerprint: z
      .string()
      .regex(/^(?:wf-compat|node-compat):v1:sha256:[0-9a-f]{64}$/u),
    issues: z.array(workflowCompatibilityIssueSchema).max(1_000),
  })
  .strict();
/** Includes server authoring findings such as invalid_expression; executable issues remain supported. */
export const workflowValidationIssueSchema = apiProblemIssueSchema;
export const workflowValidationReportSchema = z
  .object({
    valid: z.boolean(),
    issues: z
      .array(workflowValidationIssueSchema)
      .max(WORKFLOW_VALIDATION_MAX_ISSUES),
    compatibility: workflowCompatibilityReportSchema,
  })
  .strict();

export const workflowSummarySchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    name: workflowNameSchema,
    nameRevision: workflowNameRevisionSchema,
    lifecycleStatus: workflowLifecycleStatusSchema,
    lifecycleRevision: workflowLifecycleRevisionSchema,
    activationStatus: workflowActivationStatusSchema,
    publishedVersionId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const workflowSummaryResponseSchema = z
  .object({ workflow: workflowSummarySchema })
  .strict();
export type WorkflowSummaryResponse = z.output<
  typeof workflowSummaryResponseSchema
>;

/** ADR063: opt-in only; unsupported readers must never imply authoritative null. */
export const workflowTemplateOriginProjectionQuerySchema = z
  .object({ include: z.literal('templateOrigin') })
  .strict();
export const workflowTemplateOriginProjectionResponseSchema = z
  .object({
    workflow: workflowSummarySchema,
    templateOrigin: workflowTemplateOriginSchema.nullable(),
  })
  .strict();
export type WorkflowTemplateOriginProjectionResponse = z.output<
  typeof workflowTemplateOriginProjectionResponseSchema
>;

export const workflowLifecycleRequestSchema = z
  .object({
    expectedLifecycleRevision: workflowLifecycleRevisionSchema,
  })
  .strict();
export const workflowLifecycleResponseSchema = z
  .object({ workflow: workflowSummarySchema, replayed: z.boolean() })
  .strict();

export const workflowRenameRequestSchema = z
  .object({
    name: workflowNameSchema,
    expectedNameRevision: workflowNameRevisionSchema,
  })
  .strict();
export const workflowRenameResponseSchema = z
  .object({ workflow: workflowSummarySchema, replayed: z.boolean() })
  .strict();

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
export const workflowDraftSaveRequestSchema = z
  .object({ graph: workflowGraphSchema })
  .strict();
export const workflowValidateResponseSchema = workflowValidationReportSchema;

export const workflowVersionResponseSchema = z
  .object({
    id: z.uuid(),
    workflowId: z.uuid(),
    versionNumber: z.number().int().positive(),
    schemaVersion: z.literal(1),
    graph: workflowGraphSchema,
    checksum: z.string().regex(/^wf:v[12]:sha256:[0-9a-f]{64}$/u),
    publishedAt: z.iso.datetime(),
  })
  .strict();
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
    order: workflowListOrderSchema.optional(),
  })
  .strict();

/** ADR064 additive path; unchanged default schemas/cursors remain separate. */
export const workflowOrganizationListQuerySchema = workflowListQuerySchema
  .extend({
    query: workflowOrganizationNameQuerySchema.optional(),
    view: workflowOrganizationViewSchema.optional(),
    tagId: z
      .uuid()
      .overwrite((id) => id.toLowerCase())
      .optional(),
    folderId: workflowOrganizationFolderFilterSchema.optional(),
    favoritesOnly: z.literal('true').optional(),
    include: z.literal('organization').optional(),
  })
  .overwrite(({ query, ...rest }) =>
    query === '' || query === undefined ? rest : { ...rest, query },
  );
export const workflowOrganizationProjectionQuerySchema = z
  .object({
    include: z.enum(['organization', 'templateOrigin,organization']),
  })
  .strict();
/** Unified transport grammar; legacy projection validators remain unchanged. */
export const workflowGetQuerySchema = z
  .object({
    include: z
      .enum(['templateOrigin', 'organization', 'templateOrigin,organization'])
      .optional(),
  })
  .strict();
export const workflowOrganizationProjectionResponseSchema = z
  .object({
    workflow: workflowSummarySchema,
    organization: workflowOrganizationSchema,
  })
  .strict();
export const workflowCombinedOrganizationProjectionResponseSchema = z
  .object({
    workflow: workflowSummarySchema,
    templateOrigin: workflowTemplateOriginSchema.nullable(),
    organization: workflowOrganizationSchema,
  })
  .strict();
export const workflowOrganizationListResponseSchema = z
  .object({
    items: z.array(workflowOrganizationProjectionResponseSchema).max(100),
    nextCursor: workflowCursorSchema.nullable(),
  })
  .strict();
export type WorkflowOrganizationListQuery = z.output<
  typeof workflowOrganizationListQuerySchema
>;
export type WorkflowOrganizationListResponse = z.output<
  typeof workflowOrganizationListResponseSchema
>;
export type WorkflowOrganizationProjectionResponse = z.output<
  typeof workflowOrganizationProjectionResponseSchema
>;
export const workflowVersionsQuerySchema = z
  .object({
    limit: workflowPageLimitSchema.optional(),
    after: workflowCursorSchema.optional(),
  })
  .strict();

export const workflowRevisionConflictProblemSchema = createApiProblemSchema({
  status: z.literal(412),
  code: z.literal('workflow.revision_conflict'),
  currentRevision: z.number().int().positive(),
  currentEtag: strongEtagSchema,
});

export const workflowLifecycleConflictProblemSchema = createApiProblemSchema({
  status: z.literal(409),
  code: z.literal('workflow.lifecycle_conflict'),
  currentLifecycleRevision: workflowLifecycleRevisionSchema,
});
export const workflowNameConflictProblemSchema = createApiProblemSchema({
  status: z.literal(409),
  code: z.literal('workflow.name_conflict'),
  currentNameRevision: workflowNameRevisionSchema,
});
export type WorkflowLifecycleResponse = z.output<
  typeof workflowLifecycleResponseSchema
>;
export type WorkflowRenameRequest = z.output<
  typeof workflowRenameRequestSchema
>;
export type WorkflowRenameResponse = z.output<
  typeof workflowRenameResponseSchema
>;
export type WorkflowNameConflictProblem = z.output<
  typeof workflowNameConflictProblemSchema
>;
export type WorkflowLifecycleConflictProblem = z.output<
  typeof workflowLifecycleConflictProblemSchema
>;

export type WorkflowSummary = z.output<typeof workflowSummarySchema>;
export type WorkflowListQuery = z.output<typeof workflowListQuerySchema>;
export type WorkflowListResponse = z.output<typeof workflowListResponseSchema>;
export type WorkflowCreateResponse = z.output<
  typeof workflowCreateResponseSchema
>;
export type WorkflowDraftResponse = z.output<
  typeof workflowDraftResponseSchema
>;
export type WorkflowPublishResponse = z.output<
  typeof workflowPublishResponseSchema
>;
export type WorkflowValidateResponse = z.output<
  typeof workflowValidateResponseSchema
>;
export type WorkflowVersionResponse = z.output<
  typeof workflowVersionResponseSchema
>;
export type WorkflowVersionsResponse = z.output<
  typeof workflowVersionsResponseSchema
>;
export type WorkflowRevisionConflictProblem = z.output<
  typeof workflowRevisionConflictProblemSchema
>;
export * from './workflow-input-cases.js';
