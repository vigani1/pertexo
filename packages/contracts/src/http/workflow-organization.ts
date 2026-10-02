import { z } from 'zod';
import { utf8ByteLength } from '../utf8-byte-length.js';

/** ADR064 bounds are product contracts, never caller-configurable quotas. */
export const WORKFLOW_ORGANIZATION_LIMITS = Object.freeze({
  tagKeyBytes: 32,
  tagsPerWorkflow: 16,
  tagsPerWorkspace: 256,
  cleanupItems: 50,
  nameQueryBytes: 128,
  favoriteRetryHorizonHours: 24,
  favoriteAbsenceTokenBytes: 128,
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
export const workflowTagRevisionSchema = workflowOrganizationRevisionSchema;
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

/** An opaque private token, not a shared workflow revision or actor selector. */
export const workflowFavoriteAbsenceRevisionSchema = z
  .string()
  .max(WORKFLOW_ORGANIZATION_LIMITS.favoriteAbsenceTokenBytes)
  .regex(
    /^absent\.v1\.(0|[1-9][0-9]{0,11})\.(0|[1-9][0-9]{0,11})\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$(?![\s\S])/u,
  )
  .refine((value) => {
    const parts = value.split('.');
    const issued = Number(parts[2]);
    const expires = Number(parts[3]);
    return (
      Number.isSafeInteger(issued) &&
      Number.isSafeInteger(expires) &&
      issued >= 0 &&
      expires <= 253_402_300_799 &&
      expires - issued === 86_400
    );
  });
export const workflowFavoriteRevisionSchema = z.union([
  workflowFavoriteAbsenceRevisionSchema,
  commandIdentifierSchema,
]);
export const workflowFavoriteRequestSchema = z
  .object({
    favorite: z.boolean(),
    expectedFavoriteRevision: workflowFavoriteRevisionSchema,
  })
  .strict();
export const workflowFavoriteResponseSchema = z
  .object({
    isFavorite: z.boolean(),
    // Every successful new command issues a token, including false tombstones.
    favoriteRevision: commandIdentifierSchema,
    replayed: z.boolean(),
  })
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
    // Slice 1 does not claim folder storage or support enabled placeholders.
    folderId: z.null(),
    isFavorite: z.boolean(),
    favoriteRevision: workflowFavoriteRevisionSchema,
  })
  .strict()
  .refine(
    (state) =>
      !state.isFavorite || !state.favoriteRevision.startsWith('absent.'),
  );

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
