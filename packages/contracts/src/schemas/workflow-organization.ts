import { z } from 'zod';
import { strictlyAscendingIdentifiers } from './workflow-organization-order.js';
import { utf8ByteLength } from './utf8-byte-length.js';

/** ADR064 bounds are product contracts, never caller-configurable quotas. */
export const WORKFLOW_ORGANIZATION_LIMITS = Object.freeze({
  tagKeyBytes: 32,
  tagsPerWorkflow: 16,
  tagsPerWorkspace: 256,
  cleanupItems: 50,
  nameQueryBytes: 128,
});

/** U+0020 trim and ASCII-only case mapping; no Unicode fold/transliteration. */
export function normalizeWorkflowTagKey(value: string): string {
  return value
    .replace(/^ +| +$(?![\s\S])/gu, '')
    .replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

export const workflowOrganizationRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const workflowTagRevisionSchema =
  workflowOrganizationRevisionSchema.clone();
export const workflowTagKeySchema = z
  .string()
  .min(1)
  .max(WORKFLOW_ORGANIZATION_LIMITS.tagKeyBytes)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$(?![\s\S])/u);
export const workflowTagKeyInputSchema = z
  .string()
  .overwrite(normalizeWorkflowTagKey)
  .pipe(workflowTagKeySchema);

const commandIdentifierSchema = z.uuid().overwrite((id) => id.toLowerCase());
const canonicalIdentifierSchema = z
  .uuid()
  .length(36)
  .regex(/^[0-9a-f-]+(?![\s\S])/u);
export const workflowTagWorkspaceParamsSchema = z
  .object({ workspaceId: commandIdentifierSchema })
  .strict();
export const workflowTagParamsSchema = workflowTagWorkspaceParamsSchema.extend({
  tagId: commandIdentifierSchema,
});
/** UUID-page continuation; authenticity, scope, purpose and expiry are server checks. */
export const workflowOrganizationPageCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![\s\S])/u);
export const workflowTagListQuerySchema = z
  .object({
    limit: z
      .union([
        z.number().int().min(1).max(100),
        z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)(?![\s\S])/u),
      ])
      .pipe(z.coerce.number<string | number>().int().min(1).max(100))
      .optional(),
    after: workflowOrganizationPageCursorSchema.optional(),
  })
  .strict();
export const workflowTagAssignmentsQuerySchema =
  workflowTagListQuerySchema.clone();
export const workflowTagSchema = z
  .object({
    id: z.uuid(),
    key: workflowTagKeySchema,
    revision: workflowTagRevisionSchema,
  })
  .strict();
export const workflowTagCreateRequestSchema = z
  .object({ key: workflowTagKeyInputSchema })
  .strict();
export const workflowTagRenameRequestSchema = z
  .object({
    key: workflowTagKeyInputSchema,
    expectedTagRevision: workflowTagRevisionSchema,
  })
  .strict();
export const workflowTagDeleteRequestSchema = z
  .object({ expectedTagRevision: workflowTagRevisionSchema })
  .strict();

export const workflowTagCreateResponseSchema = z
  .object({ tag: workflowTagSchema, replayed: z.boolean() })
  .strict();
export const workflowTagRenameResponseSchema =
  workflowTagCreateResponseSchema.clone();
export const workflowTagDeleteResponseSchema = z
  .object({
    tagId: canonicalIdentifierSchema,
    deleted: z.literal(true),
    detachedWorkflowCount: z
      .number()
      .int()
      .min(0)
      .max(WORKFLOW_ORGANIZATION_LIMITS.cleanupItems),
    replayed: z.boolean(),
  })
  .strict();
export const workflowTagReplaceResponseSchema = z
  .object({
    workflowId: canonicalIdentifierSchema,
    organizationRevision: workflowOrganizationRevisionSchema,
    tagIds: z
      .array(canonicalIdentifierSchema)
      .max(WORKFLOW_ORGANIZATION_LIMITS.tagsPerWorkflow)
      .refine((ids) => new Set(ids).size === ids.length),
    replayed: z.boolean(),
  })
  .strict();

export const workflowTagListResponseSchema = z
  .object({
    items: z
      .array(workflowTagSchema.extend({ id: canonicalIdentifierSchema }))
      .max(100)
      .refine((items) =>
        strictlyAscendingIdentifiers(items.map((item) => item.id)),
      ),
    nextCursor: workflowOrganizationPageCursorSchema.nullable(),
  })
  .strict();
export const workflowTagAssignmentSchema = z
  .object({
    workflowId: canonicalIdentifierSchema,
    organizationRevision: workflowOrganizationRevisionSchema,
  })
  .strict();
export const workflowTagAssignmentsResponseSchema = z
  .object({
    items: z
      .array(workflowTagAssignmentSchema)
      .max(100)
      .refine((items) =>
        strictlyAscendingIdentifiers(items.map((item) => item.workflowId)),
      ),
    nextCursor: workflowOrganizationPageCursorSchema.nullable(),
  })
  .strict();
export const workflowTagReplaceRequestSchema = z
  .object({
    tagIds: z
      .array(commandIdentifierSchema)
      .max(WORKFLOW_ORGANIZATION_LIMITS.tagsPerWorkflow)
      .refine((ids) => new Set(ids).size === ids.length)
      .overwrite((ids) => [...ids].sort()),
    expectedOrganizationRevision: workflowOrganizationRevisionSchema,
  })
  .strict();
export const workflowTagCleanupDetachRequestSchema = z
  .object({
    tagId: commandIdentifierSchema,
    items: z
      .array(
        z
          .object({
            workflowId: commandIdentifierSchema,
            expectedOrganizationRevision: workflowOrganizationRevisionSchema,
          })
          .strict(),
      )
      .min(1)
      .max(WORKFLOW_ORGANIZATION_LIMITS.cleanupItems)
      .refine(
        (items) =>
          new Set(items.map((item) => item.workflowId)).size === items.length,
      ),
  })
  .strict();

export const workflowTagCleanupConflictCodeSchema = z.enum([
  'workflow.organization_revision_conflict',
  'request.idempotency_conflict',
  'workflow.lifecycle_conflict',
]);
const cleanupItemIdentity = { workflowId: canonicalIdentifierSchema };
export const workflowTagCleanupItemOutcomeSchema = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        ...cleanupItemIdentity,
        status: z.literal('detached'),
        organizationRevision: workflowOrganizationRevisionSchema,
        replayed: z.boolean(),
      })
      .strict(),
    z
      .object({ ...cleanupItemIdentity, status: z.literal('not_visible') })
      .strict(),
    z
      .object({
        ...cleanupItemIdentity,
        status: z.literal('conflict'),
        code: workflowTagCleanupConflictCodeSchema,
      })
      .strict(),
    z
      .object({
        ...cleanupItemIdentity,
        status: z.literal('unavailable'),
        code: z.literal('workflow.organization_unavailable'),
      })
      .strict(),
    z
      .object({ ...cleanupItemIdentity, status: z.literal('outcome_unknown') })
      .strict(),
    z
      .object({ ...cleanupItemIdentity, status: z.literal('forbidden') })
      .strict(),
    z
      .object({ ...cleanupItemIdentity, status: z.literal('not_processed') })
      .strict(),
  ],
);
export const workflowTagCleanupDetachResponseSchema = z
  .object({
    items: z
      .array(workflowTagCleanupItemOutcomeSchema)
      .min(1)
      .max(WORKFLOW_ORGANIZATION_LIMITS.cleanupItems)
      .refine(
        (items) =>
          new Set(items.map((item) => item.workflowId)).size === items.length,
      )
      .refine((items) => {
        let authorityLost = false;
        for (const item of items) {
          if (authorityLost && item.status !== 'not_processed') return false;
          if (!authorityLost && item.status === 'not_processed') return false;
          if (item.status === 'forbidden') authorityLost = true;
        }
        return true;
      }),
  })
  .strict();

/** Sets the actor's favorite; asking for the current state changes nothing. */
export const workflowFavoriteRequestSchema = z
  .object({ favorite: z.boolean() })
  .strict();
export const workflowFavoriteResponseSchema = z
  .object({ isFavorite: z.boolean() })
  .strict();

export const workflowOrganizationSchema = z
  .object({
    tags: z
      .array(workflowTagSchema)
      .max(WORKFLOW_ORGANIZATION_LIMITS.tagsPerWorkflow)
      .refine(
        (tags) =>
          new Set(tags.map((tag) => tag.id.toLowerCase())).size ===
            tags.length &&
          new Set(tags.map((tag) => tag.key)).size === tags.length,
      ),
    organizationRevision: workflowOrganizationRevisionSchema,
    folderId: z.uuid().nullable(),
    isFavorite: z.boolean(),
  })
  .strict();

/** Literal case-sensitive substring. Only outer U+0020 is trimmed. */
export const workflowOrganizationNameQuerySchema = z
  .string()
  .overwrite((query) => query.replace(/^ +| +$(?![\s\S])/gu, ''))
  .refine(
    (query) =>
      utf8ByteLength(query) <= WORKFLOW_ORGANIZATION_LIMITS.nameQueryBytes,
  );
export const workflowOrganizationViewSchema = z.enum([
  'active',
  'archived',
  'all',
]);

export type WorkflowTag = z.output<typeof workflowTagSchema>;
export type WorkflowOrganization = z.output<typeof workflowOrganizationSchema>;
export type WorkflowFavoriteRequest = z.output<
  typeof workflowFavoriteRequestSchema
>;
export type WorkflowTagReplaceRequest = z.output<
  typeof workflowTagReplaceRequestSchema
>;
export type WorkflowTagWorkspaceParams = z.output<
  typeof workflowTagWorkspaceParamsSchema
>;
export type WorkflowTagParams = z.output<typeof workflowTagParamsSchema>;
export type WorkflowTagListQuery = z.output<typeof workflowTagListQuerySchema>;
export type WorkflowTagAssignmentsQuery = z.output<
  typeof workflowTagAssignmentsQuerySchema
>;
export type WorkflowTagCreateRequest = z.output<
  typeof workflowTagCreateRequestSchema
>;
export type WorkflowTagRenameRequest = z.output<
  typeof workflowTagRenameRequestSchema
>;
export type WorkflowTagDeleteRequest = z.output<
  typeof workflowTagDeleteRequestSchema
>;
export type WorkflowTagListResponse = z.output<
  typeof workflowTagListResponseSchema
>;
export type WorkflowTagAssignmentsResponse = z.output<
  typeof workflowTagAssignmentsResponseSchema
>;
export type WorkflowTagCreateResponse = z.output<
  typeof workflowTagCreateResponseSchema
>;
export type WorkflowTagRenameResponse = z.output<
  typeof workflowTagRenameResponseSchema
>;
export type WorkflowTagDeleteResponse = z.output<
  typeof workflowTagDeleteResponseSchema
>;
export type WorkflowTagReplaceResponse = z.output<
  typeof workflowTagReplaceResponseSchema
>;
export type WorkflowTagCleanupDetachRequest = z.output<
  typeof workflowTagCleanupDetachRequestSchema
>;
export type WorkflowTagCleanupDetachResponse = z.output<
  typeof workflowTagCleanupDetachResponseSchema
>;
export type WorkflowTagCleanupItemOutcome = z.output<
  typeof workflowTagCleanupItemOutcomeSchema
>;
