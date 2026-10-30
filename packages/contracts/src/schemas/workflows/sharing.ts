import { FOLDER_GRANT_LIMIT } from '@pertexo/workflow-model';
import { z } from 'zod';
import { workspaceRoleSchema } from '../identity/membership.js';
const id = z.uuid().overwrite((value) => value.toLowerCase());
const access = z.enum(['viewer', 'editor']);
export const folderPrincipalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('member'), userId: id, access }).strict(),
  z
    .object({
      kind: z.literal('group'),
      organizationId: id,
      groupId: id,
      access,
    })
    .strict(),
]);
export const folderSharingRequestSchema = z
  .object({
    mode: z.enum(['workspace', 'restricted']),
    expectedFolderRevision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    grants: z
      .array(folderPrincipalSchema)
      .max(FOLDER_GRANT_LIMIT)
      .refine(
        (grants) =>
          new Set(
            grants.map((grant) =>
              grant.kind === 'member'
                ? `member:${grant.userId}`
                : `group:${grant.organizationId}:${grant.groupId}`,
            ),
          ).size === grants.length,
      ),
  })
  .strict()
  .refine((value) => value.mode === 'restricted' || value.grants.length === 0);
export const folderSharingResponseSchema = z
  .object({
    folderId: id,
    revision: z.number().int().positive(),
    mode: z.enum(['workspace', 'restricted']),
    grants: z.array(folderPrincipalSchema).max(FOLDER_GRANT_LIMIT),
    labels: z
      .record(id, z.string())
      .refine((labels) => Object.keys(labels).length <= FOLDER_GRANT_LIMIT)
      .optional(),
  })
  .strict();
export const folderSharingCommandResponseSchema =
  folderSharingResponseSchema.extend({ replayed: z.boolean() });
export const audienceReviewSchema = z
  .object({
    token: z.string().regex(/^[a-f0-9]{64}$/u),
    acknowledge: z.literal(true),
  })
  .strict();
export const workflowMoveReviewRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('workflows'),
      workflowIds: z
        .array(id)
        .min(1)
        .max(50)
        .refine((ids) => new Set(ids).size === ids.length),
      destinationFolderId: id.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('folder'),
      folderId: id,
      destinationFolderId: id.nullable(),
    })
    .strict(),
]);
export const workflowMoveReviewItemSchema = z
  .object({
    id,
    requiresReview: z.boolean(),
    token: z.string().regex(/^[a-f0-9]{64}$/u),
    removedRestrictions: z
      .array(z.object({ id, name: z.string() }).strict())
      .max(256),
  })
  .strict();
export const workflowMoveReviewResponseSchema = z
  .object({ items: z.array(workflowMoveReviewItemSchema).min(1).max(50) })
  .strict();
export type FolderSharingRequest = z.output<typeof folderSharingRequestSchema>;
export type FolderSharing = z.output<typeof folderSharingResponseSchema>;
export type FolderPrincipal = z.output<typeof folderPrincipalSchema>;
export type AudienceReview = z.output<typeof audienceReviewSchema>;
export type WorkflowMoveReviewRequest = z.output<
  typeof workflowMoveReviewRequestSchema
>;
export type WorkflowMoveReview = z.output<
  typeof workflowMoveReviewResponseSchema
>;
export type WorkflowMoveReviewItem = z.output<
  typeof workflowMoveReviewItemSchema
>;

export const sharingPrincipalsQuerySchema = z
  .object({
    kind: z.enum(['member', 'group']),
    search: z.string().trim().max(128).optional(),
    after: id.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const sharingPrincipalSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('member'),
      userId: id,
      label: z.string(),
      // Owners and admins always have access, so pickers can say so instead of offering them.
      email: z.string().max(320),
      role: workspaceRoleSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('group'),
      organizationId: id,
      groupId: id,
      label: z.string(),
    })
    .strict(),
]);
export const sharingPrincipalsResponseSchema = z
  .object({
    items: z.array(sharingPrincipalSchema).max(100),
    next: id.nullable(),
  })
  .strict();
export type SharingPrincipalsQuery = z.output<
  typeof sharingPrincipalsQuerySchema
>;
export type SharingPrincipals = z.output<
  typeof sharingPrincipalsResponseSchema
>;
