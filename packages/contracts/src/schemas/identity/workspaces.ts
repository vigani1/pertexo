import { responseSchema } from '../shared/response-schema.js';
import {
  ALL_WORKSPACE_STATUSES,
  DISCOVERABLE_WORKSPACE_STATUSES,
  AUTHORIZATION_CAPABILITIES,
} from '@pertexo/policy';
import { storageTextSchema } from '@pertexo/workflow-model';
import { directoryMembershipSourceSchema } from './federation/directory.js';
import {
  workspaceRoleSchema,
  delegatedWorkspaceRoleSchema,
} from './membership.js';
import { z } from 'zod';
import {
  DISPLAY_NAME_MAX_CHARACTERS,
  EMAIL_ADDRESS_LIMITS,
  USER_DISPLAY_NAME_MAX_CHARACTERS,
} from '@pertexo/workflow-model';
import { RESOURCE_NAME_MAX_LENGTH } from '../shared/resource-name.js';

const WORKSPACES_BOUNDS = Object.freeze({
  emailMinimumCharacters: EMAIL_ADDRESS_LIMITS.minimumCharacters,
  emailCharacters: EMAIL_ADDRESS_LIMITS.storedAddressCharacters,
  workspaceInvitationsPageItems: 100,
  nextCursorCharacters: 512,
  workspaceInvitationsPageMaximum: 100,
  afterCharacters: 512,
  workspaceMembersPageItems: 100,
  workspaceMembersPageMaximum: 100,
  accessibleWorkspacesPageMaximum: 100,
  accessibleWorkspacesPageItems: 100,
});

export { idempotencyKeySchema } from '../shared/transport-headers.js';

/** What a workspace's own text fields hold. */
export const WORKSPACE_TEXT_LIMITS = Object.freeze({
  slugCharacters: 64,
  deletionReasonCharacters: 512,
});
export const workspaceCreateRequestSchema = z
  .object({
    name: storageTextSchema.trim().min(1).max(RESOURCE_NAME_MAX_LENGTH),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(WORKSPACE_TEXT_LIMITS.slugCharacters)
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
  })
  .strict();
const workspaceRevisionSchema = z.number().int().positive();
export const workspaceRenameRequestSchema = z
  .object({
    name: storageTextSchema.trim().min(1).max(RESOURCE_NAME_MAX_LENGTH),
    expectedRevision: workspaceRevisionSchema,
  })
  .strict();
export const workspaceDeletionRequestSchema = z
  .object({
    reason: storageTextSchema
      .trim()
      .min(1)
      .max(WORKSPACE_TEXT_LIMITS.deletionReasonCharacters),
  })
  .strict();
export const workspaceIdentifierSchema = z.uuid();
export const workspaceIdParamSchema = z
  .object({ workspaceId: workspaceIdentifierSchema })
  .strict();
export const workspaceMemberRoleParamsSchema = z
  .object({
    workspaceId: workspaceIdentifierSchema,
    userId: z.uuid(),
  })
  .strict();
const workspaceInvitationIdentifierSchema = z.uuid();
export const workspaceInvitationParamsSchema = z
  .object({
    workspaceId: workspaceIdentifierSchema,
    invitationId: workspaceInvitationIdentifierSchema,
  })
  .strict();
export const workspaceResponseSchema = responseSchema(
  z
    .object({
      id: z.uuid(),
      name: z.string(),
      slug: z.string(),
      status: z.enum(ALL_WORKSPACE_STATUSES),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    })
    .strict(),
);
const userProfileRevisionSchema = z.number().int().positive();
export const userProfileResponseSchema = responseSchema(
  z
    .object({
      id: z.uuid(),
      email: z
        .string()
        .trim()
        .min(WORKSPACES_BOUNDS.emailMinimumCharacters)
        .max(WORKSPACES_BOUNDS.emailCharacters),
      displayName: z.string().trim().min(1).max(DISPLAY_NAME_MAX_CHARACTERS),
      status: z.enum(['active', 'suspended', 'deleted']),
      revision: userProfileRevisionSchema,
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    })
    .strict(),
);
/** ADR 043: the name teammates see; printable text. */
export const userDisplayNameSchema = storageTextSchema
  .trim()
  .min(1)
  .max(USER_DISPLAY_NAME_MAX_CHARACTERS)
  .regex(/^[^\p{Cc}]+$/u);
export const userProfileUpdateRequestSchema = z
  .object({
    displayName: userDisplayNameSchema,
    expectedRevision: userProfileRevisionSchema,
  })
  .strict();
export const userProfileUpdateResponseSchema = responseSchema(
  z
    .object({
      profile: userProfileResponseSchema,
      changed: z.boolean(),
      replayed: z.boolean(),
    })
    .strict(),
);

export const workspaceMemberSchema = z
  .object({
    userId: z.uuid(),
    email: z
      .string()
      .trim()
      .min(WORKSPACES_BOUNDS.emailMinimumCharacters)
      .max(WORKSPACES_BOUNDS.emailCharacters),
    displayName: z.string().trim().min(1).max(DISPLAY_NAME_MAX_CHARACTERS),
    role: workspaceRoleSchema,
    roleRevision: z.number().int().positive(),
    membershipStatus: z.enum(['active', 'suspended']),
    directorySource: directoryMembershipSourceSchema.optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const workspaceMemberRoleChangeRequestSchema = z
  .object({
    role: delegatedWorkspaceRoleSchema,
    expectedRoleRevision: z.number().int().positive(),
  })
  .strict();
export const workspaceMemberRoleChangeResponseSchema = responseSchema(
  z
    .object({
      userId: z.uuid(),
      role: delegatedWorkspaceRoleSchema,
      roleRevision: z.number().int().positive(),
      changed: z.boolean(),
      replayed: z.boolean(),
    })
    .strict(),
);
/** ADR 042: removal is fenced by the membership's role revision. */
export const workspaceMemberRemovalRequestSchema = z
  .object({ expectedRoleRevision: z.number().int().positive() })
  .strict();
export const workspaceMemberRemovalResponseSchema = responseSchema(
  z
    .object({
      userId: z.uuid(),
      roleRevision: z.number().int().positive(),
      replayed: z.boolean(),
    })
    .strict(),
);
const workspaceInvitationStatusSchema = z.enum([
  'pending',
  'accepted',
  'revoked',
  'expired',
]);
const workspaceInvitationDeliveryStatusSchema = z.enum([
  'queued',
  'submitted',
  'failed',
  'canceled',
  'unknown',
]);
export const workspaceInvitationSchema = z
  .object({
    id: workspaceInvitationIdentifierSchema,
    email: z.email().max(WORKSPACES_BOUNDS.emailCharacters),
    role: delegatedWorkspaceRoleSchema,
    status: workspaceInvitationStatusSchema,
    revision: z.number().int().positive(),
    deliveryStatus: workspaceInvitationDeliveryStatusSchema,
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const workspaceInvitationCreateRequestSchema = z
  .object({
    email: z
      .string()
      .trim()
      .pipe(z.email().max(EMAIL_ADDRESS_LIMITS.newAddressCharacters)),
    role: delegatedWorkspaceRoleSchema,
  })
  .strict();
export const workspaceInvitationCommandRequestSchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();
export const workspaceInvitationCommandResponseSchema = responseSchema(
  z
    .object({
      invitation: workspaceInvitationSchema,
      replayed: z.boolean(),
    })
    .strict(),
);
export const workspaceInvitationsResponseSchema = responseSchema(
  z
    .object({
      issuanceAvailable: z.boolean(),
      items: z
        .array(workspaceInvitationSchema)
        .max(WORKSPACES_BOUNDS.workspaceInvitationsPageItems),
      nextCursor: z
        .string()
        .min(1)
        .max(WORKSPACES_BOUNDS.nextCursorCharacters)
        .nullable(),
    })
    .strict(),
);
export const workspaceInvitationsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(WORKSPACES_BOUNDS.workspaceInvitationsPageMaximum)
      .optional(),
    after: z.string().min(1).max(WORKSPACES_BOUNDS.afterCharacters).optional(),
  })
  .strict();

export const workspaceMembersResponseSchema = responseSchema(
  z
    .object({
      items: z
        .array(workspaceMemberSchema)
        .max(WORKSPACES_BOUNDS.workspaceMembersPageItems),
      nextCursor: z
        .string()
        .min(1)
        .max(WORKSPACES_BOUNDS.nextCursorCharacters)
        .nullable(),
    })
    .strict(),
);
export const workspaceMembersQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(WORKSPACES_BOUNDS.workspaceMembersPageMaximum)
      .optional(),
    after: z.string().min(1).max(WORKSPACES_BOUNDS.afterCharacters).optional(),
  })
  .strict();
export const accessibleWorkspacesQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(WORKSPACES_BOUNDS.accessibleWorkspacesPageMaximum)
      .optional(),
    after: workspaceIdentifierSchema.optional(),
  })
  .strict();
const workspaceCapabilitySchema = z.enum(AUTHORIZATION_CAPABILITIES);
export const accessibleWorkspaceSchema = workspaceResponseSchema
  .extend({
    status: z.enum(DISCOVERABLE_WORKSPACE_STATUSES),
    revision: workspaceRevisionSchema,
    role: workspaceRoleSchema,
    capabilities: z
      .array(workspaceCapabilitySchema)
      .max(workspaceCapabilitySchema.options.length),
  })
  .strict();
export const workspaceRenameResponseSchema = responseSchema(
  z
    .object({
      workspace: workspaceResponseSchema.extend({
        revision: workspaceRevisionSchema,
      }),
      changed: z.boolean(),
      replayed: z.boolean(),
    })
    .strict(),
);
export const accessibleWorkspacesResponseSchema = responseSchema(
  z
    .object({
      items: z
        .array(accessibleWorkspaceSchema)
        .max(WORKSPACES_BOUNDS.accessibleWorkspacesPageItems),
      nextCursor: workspaceIdentifierSchema.nullable(),
    })
    .strict(),
);
/** Lifecycle changes finish inside the request; a retry with the same key replays it. */
export const workspaceLifecycleChangeResponseSchema = responseSchema(
  z
    .object({
      workspaceId: workspaceIdentifierSchema,
      change: z.enum([
        'deletion_requested',
        'deletion_restored',
        'reactivated',
      ]),
      occurredAt: z.iso.datetime(),
    })
    .strict(),
);

export type WorkspaceResponse = z.output<typeof workspaceResponseSchema>;
export type WorkspaceCreateRequest = z.output<
  typeof workspaceCreateRequestSchema
>;
export type WorkspaceRenameRequest = z.output<
  typeof workspaceRenameRequestSchema
>;
export type WorkspaceRenameResponse = z.output<
  typeof workspaceRenameResponseSchema
>;
export type UserProfileResponse = z.output<typeof userProfileResponseSchema>;
export type UserProfileUpdateResponse = z.output<
  typeof userProfileUpdateResponseSchema
>;
export type WorkspaceMember = z.output<typeof workspaceMemberSchema>;
export type WorkspaceMemberRoleChangeResponse = z.output<
  typeof workspaceMemberRoleChangeResponseSchema
>;
export type WorkspaceMemberRemovalResponse = z.output<
  typeof workspaceMemberRemovalResponseSchema
>;
export type WorkspaceInvitation = z.output<typeof workspaceInvitationSchema>;
export type WorkspaceInvitationCommandResponse = z.output<
  typeof workspaceInvitationCommandResponseSchema
>;
export type WorkspaceInvitationsResponse = z.output<
  typeof workspaceInvitationsResponseSchema
>;
export type WorkspaceMembersResponse = z.output<
  typeof workspaceMembersResponseSchema
>;
export type AccessibleWorkspace = z.output<typeof accessibleWorkspaceSchema>;
export type AccessibleWorkspacesResponse = z.output<
  typeof accessibleWorkspacesResponseSchema
>;
export type WorkspaceLifecycleChangeResponse = z.output<
  typeof workspaceLifecycleChangeResponseSchema
>;
