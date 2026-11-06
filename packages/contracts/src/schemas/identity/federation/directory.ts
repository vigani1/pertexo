import { DIRECTORY_LIMITS } from '@pertexo/workflow-model';
export { DIRECTORY_LIMITS };
import { FEDERATION_LIMITS } from './settings.js';
import { z } from 'zod';
import { delegatedWorkspaceRoleSchema } from '../membership.js';

const revision = z.number().int().positive().max(2147483647);
export const directoryCredentialSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    createdAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
    lastUsedAt: z.iso.datetime().nullable(),
  })
  .strict();
export const directoryCredentialCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    expectedRevision: revision,
  })
  .strict();
export const directoryCredentialResultSchema = z.discriminatedUnion(
  'replayed',
  [
    z
      .object({
        credential: directoryCredentialSchema,
        replayed: z.literal(false),
        secret: z.string(),
      })
      .strict(),
    z
      .object({
        credential: directoryCredentialSchema,
        replayed: z.literal(true),
      })
      .strict(),
  ],
);
export const directoryRevisionSchema = z
  .object({ expectedRevision: revision })
  .strict();
export const directoryMappingsSchema = z
  .object({
    expectedRevision: revision,
    mappings: z
      .array(
        z
          .object({
            groupId: z.uuid(),
            workspaceId: z.uuid(),
            role: delegatedWorkspaceRoleSchema,
            priority: z
              .number()
              .int()
              .min(0)
              .max(DIRECTORY_LIMITS.mappingsPerWorkspace - 1),
          })
          .strict(),
      )
      .max(DIRECTORY_LIMITS.groups * FEDERATION_LIMITS.workspaces),
  })
  .strict()
  .superRefine((value, ctx) => {
    const groups = new Set<string>(),
      priorities = new Set<string>(),
      counts = new Map<string, number>();
    for (const mapping of value.mappings) {
      const group = `${mapping.workspaceId}:${mapping.groupId}`,
        priority = `${mapping.workspaceId}:${String(mapping.priority)}`;
      const count = (counts.get(mapping.workspaceId) ?? 0) + 1;
      counts.set(mapping.workspaceId, count);
      if (
        groups.has(group) ||
        priorities.has(priority) ||
        count > DIRECTORY_LIMITS.mappingsPerWorkspace
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'Use each group and priority once per workspace, within its mapping limit.',
        });
      groups.add(group);
      priorities.add(priority);
    }
  });
export const directoryAdoptSchema = z
  .object({
    targetWorkspaceId: z.uuid(),
    expectedRevision: revision,
    directoryUserId: z.uuid(),
    directoryRevision: revision,
    membershipRevision: revision,
    role: delegatedWorkspaceRoleSchema,
  })
  .strict();
export const directorySettingsSchema = z
  .object({
    canManage: z.boolean(),
    organizationId: z.uuid(),
    controlWorkspaceId: z.uuid(),
    revision,
    counts: z
      .object({
        users: z.number().int(),
        activeUsers: z.number().int(),
        groups: z.number().int(),
      })
      .strict(),
    credentials: z.array(directoryCredentialSchema).max(50),
    groups: z
      .array(
        z
          .object({
            id: z.uuid(),
            displayName: z.string(),
            memberCount: z.number().int(),
          })
          .strict(),
      )
      .max(DIRECTORY_LIMITS.groups),
    mappings: directoryMappingsSchema.shape.mappings,
  })
  .strict();
export const directoryPeopleQuerySchema = z
  .object({
    search: z.string().max(320).optional(),
    after: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export const directoryPeoplePageSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.uuid(),
            userName: z.string(),
            email: z.string(),
            active: z.boolean(),
            boundUserId: z.uuid().nullable(),
            revision,
            deleted: z.boolean(),
          })
          .strict(),
      )
      .max(100),
    nextCursor: z.uuid().nullable(),
  })
  .strict();
export type DirectorySettings = z.output<typeof directorySettingsSchema>;
export type DirectoryCredential = z.output<typeof directoryCredentialSchema>;
export type DirectoryCredentialResult = z.output<
  typeof directoryCredentialResultSchema
>;
export type DirectoryMappings = z.output<typeof directoryMappingsSchema>;
export type DirectoryAdopt = z.output<typeof directoryAdoptSchema>;
export type DirectoryPeopleQuery = z.output<typeof directoryPeopleQuerySchema>;

export const directoryMembershipSourceSchema = z
  .object({
    organizationId: z.uuid(),
    directoryUserId: z.uuid(),
    directoryRevision: revision,
    controlWorkspaceId: z.uuid(),
  })
  .strict();
export type DirectoryMembershipSource = z.output<
  typeof directoryMembershipSourceSchema
>;

export const directoryChangedSchema = z
  .object({ changed: z.literal(true) })
  .strict();

export const directoryAdoptionQuerySchema = z
  .object({ directoryUserId: z.uuid(), targetWorkspaceId: z.uuid() })
  .strict();
export const directoryAdoptionPreviewSchema = z.discriminatedUnion('eligible', [
  z.object({ eligible: z.literal(false), reason: z.string() }).strict(),
  z
    .object({
      eligible: z.literal(true),
      displayName: z.string(),
      currentRole: z.string(),
      command: directoryAdoptSchema,
    })
    .strict(),
]);
export type DirectoryAdoptionQuery = z.output<
  typeof directoryAdoptionQuerySchema
>;
export type DirectoryAdoptionPreview = z.output<
  typeof directoryAdoptionPreviewSchema
>;
