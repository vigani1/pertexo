import { z } from 'zod';

export { idempotencyKeySchema } from './transport-headers.js';
/** The published identity-workspace schema entry also carries authentication. */
export * from './authentication.js';

export const workspaceCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
  })
  .strict();
export const workspaceRevisionSchema = z.number().int().positive();
export const workspaceRenameRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    expectedRevision: workspaceRevisionSchema,
  })
  .strict();
export const workspaceDeletionRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(512),
  })
  .strict();
export const workspaceIdentifierSchema = z.uuid();
export const workspaceLifecycleOperationIdentifierSchema = z.uuid();
export const workspaceIdParamSchema = z
  .object({ workspaceId: workspaceIdentifierSchema })
  .strict();
export const workspaceLifecycleOperationParamsSchema = z
  .object({
    workspaceId: workspaceIdentifierSchema,
    operationId: workspaceLifecycleOperationIdentifierSchema,
  })
  .strict();
export const workspaceMemberRoleParamsSchema = z
  .object({
    workspaceId: workspaceIdentifierSchema,
    userId: z.uuid(),
  })
  .strict();
export const workspaceInvitationIdentifierSchema = z.uuid();
export const workspaceInvitationParamsSchema = z
  .object({
    workspaceId: workspaceIdentifierSchema,
    invitationId: workspaceInvitationIdentifierSchema,
  })
  .strict();
export const workspaceResponseSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    status: z.enum([
      'active',
      'suspended',
      'pending_deletion',
      'purging',
      'deleted',
    ]),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const userProfileResponseSchema = z
  .object({
    id: z.uuid(),
    email: z.string().trim().min(3).max(320),
    displayName: z.string().trim().min(1).max(256),
    status: z.enum(['active', 'suspended', 'deleted']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const workspaceRoleSchema = z.enum([
  'owner',
  'admin',
  'builder',
  'operator',
  'viewer',
]);
export const delegatedWorkspaceRoleSchema = workspaceRoleSchema.exclude([
  'owner',
]);
export const workspaceMemberSchema = z
  .object({
    userId: z.uuid(),
    email: z.string().trim().min(3).max(320),
    displayName: z.string().trim().min(1).max(256),
    role: workspaceRoleSchema,
    roleRevision: z.number().int().positive(),
    membershipStatus: z.enum(['active', 'suspended']),
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
export const workspaceMemberRoleChangeResponseSchema = z
  .object({
    userId: z.uuid(),
    role: delegatedWorkspaceRoleSchema,
    roleRevision: z.number().int().positive(),
    changed: z.boolean(),
    replayed: z.boolean(),
  })
  .strict();
export const workspaceInvitationStatusSchema = z.enum([
  'pending',
  'accepted',
  'revoked',
  'expired',
]);
export const workspaceInvitationDeliveryStatusSchema = z.enum([
  'queued',
  'submitted',
  'failed',
  'canceled',
]);
export const workspaceInvitationSchema = z
  .object({
    id: workspaceInvitationIdentifierSchema,
    email: z.email().max(320),
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
    email: z.string().trim().pipe(z.email().max(320)),
    role: delegatedWorkspaceRoleSchema,
  })
  .strict();
export const workspaceInvitationCommandRequestSchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();
export const workspaceInvitationCommandResponseSchema = z
  .object({
    invitation: workspaceInvitationSchema,
    replayed: z.boolean(),
  })
  .strict();
export const workspaceInvitationsResponseSchema = z
  .object({
    items: z.array(workspaceInvitationSchema).max(100),
    nextCursor: z.string().min(1).max(512).nullable(),
  })
  .strict();
export const workspaceInvitationsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    after: z.string().min(1).max(512).optional(),
  })
  .strict();

export const invitationAcceptanceResolveRequestSchema = z
  .object({ token: z.string().min(1).max(1_024) })
  .strict();
export const invitationAcceptanceOidcRequestSchema = z.object({}).strict();
export const invitationAcceptanceCompleteRequestSchema = z
  .object({
    intentId: z.uuid(),
    expectedRevision: z.number().int().positive(),
  })
  .strict();
const acceptanceBaseShape = {
  intentId: z.uuid(),
  expiresAt: z.iso.datetime(),
  csrfToken: z.string().min(32).max(512),
} satisfies z.ZodRawShape;
const acceptanceUnavailableSchema = z
  .object({ state: z.literal('unavailable') })
  .strict();
const acceptanceBoundStateSchema = z.discriminatedUnion('state', [
  z
    .object({
      ...acceptanceBaseShape,
      state: z.literal('sign_in_required'),
    })
    .strict(),
  z
    .object({ ...acceptanceBaseShape, state: z.literal('wrong_account') })
    .strict(),
  z.object({ ...acceptanceBaseShape, state: z.literal('expired') }).strict(),
  z.object({ ...acceptanceBaseShape, state: z.literal('revoked') }).strict(),
  z.object({ ...acceptanceBaseShape, state: z.literal('superseded') }).strict(),
  z
    .object({
      ...acceptanceBaseShape,
      state: z.literal('ready'),
      workspace: z
        .object({
          id: workspaceIdentifierSchema,
          name: z.string().min(1).max(128),
        })
        .strict(),
      role: delegatedWorkspaceRoleSchema,
      invitationRevision: z.number().int().positive(),
      sessionRotationRequired: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...acceptanceBaseShape,
      state: z.literal('completed'),
      workspace: z
        .object({
          id: workspaceIdentifierSchema,
          name: z.string().min(1).max(128),
        })
        .strict(),
      role: workspaceRoleSchema,
      membershipCreated: z.boolean(),
    })
    .strict(),
]);
export const invitationAcceptanceJourneySchema = z.union([
  acceptanceUnavailableSchema,
  acceptanceBoundStateSchema,
]);
export const invitationAcceptanceReceiptSchema = z
  .object({
    intentId: z.uuid(),
    workspaceId: workspaceIdentifierSchema,
    role: workspaceRoleSchema,
    membershipCreated: z.boolean(),
    replayed: z.boolean(),
  })
  .strict();
export const workspaceMembersResponseSchema = z
  .object({
    items: z.array(workspaceMemberSchema).max(100),
    nextCursor: z.string().min(1).max(512).nullable(),
  })
  .strict();
export const workspaceMembersQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    after: z.string().min(1).max(512).optional(),
  })
  .strict();
export const accessibleWorkspacesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    after: workspaceIdentifierSchema.optional(),
  })
  .strict();
export const workspaceCapabilitySchema = z.enum([
  'workspace:read',
  'workspace:manage',
  'artifact:read',
  'artifact:upload',
  'workflow:read',
  'workflow:create',
  'workflow:update',
  'workflow:publish',
  'run:read',
  'run:start',
  'run:cancel',
  'run:replay',
  'connection:read',
  'connection:use',
  'connection:manage',
  'member:read',
  'member:manage',
]);
export const accessibleWorkspaceSchema = workspaceResponseSchema
  .extend({
    status: z.enum(['active', 'suspended', 'pending_deletion']),
    revision: workspaceRevisionSchema,
    role: workspaceRoleSchema,
    capabilities: z.array(workspaceCapabilitySchema).max(17),
  })
  .strict();
export const workspaceRenameResponseSchema = z
  .object({
    workspace: workspaceResponseSchema.extend({
      revision: workspaceRevisionSchema,
    }),
    changed: z.boolean(),
    replayed: z.boolean(),
  })
  .strict();
export const accessibleWorkspacesResponseSchema = z
  .object({
    items: z.array(accessibleWorkspaceSchema).max(100),
    nextCursor: workspaceIdentifierSchema.nullable(),
  })
  .strict();
export const workspaceLifecycleOperationResponseSchema = z
  .object({
    id: workspaceLifecycleOperationIdentifierSchema,
    workspaceId: workspaceIdentifierSchema,
    commandType: z.enum(['deletion_requested', 'deletion_restored']),
    status: z.enum(['pending', 'running', 'completed', 'failed']),
    submittedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    errorCode: z
      .string()
      .regex(/^[a-z][a-z0-9_.:-]{0,63}$/u)
      .nullable(),
    result: z
      .object({ workspaceId: workspaceIdentifierSchema })
      .strict()
      .nullable(),
  })
  .strict();

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
export type WorkspaceMember = z.output<typeof workspaceMemberSchema>;
export type WorkspaceMemberRoleChangeRequest = z.input<
  typeof workspaceMemberRoleChangeRequestSchema
>;
export type WorkspaceMemberRoleChangeResponse = z.output<
  typeof workspaceMemberRoleChangeResponseSchema
>;
export type WorkspaceInvitation = z.output<typeof workspaceInvitationSchema>;
export type WorkspaceInvitationCreateRequest = z.input<
  typeof workspaceInvitationCreateRequestSchema
>;
export type WorkspaceInvitationCommandResponse = z.output<
  typeof workspaceInvitationCommandResponseSchema
>;
export type WorkspaceInvitationCommandRequest = z.input<
  typeof workspaceInvitationCommandRequestSchema
>;
export type WorkspaceInvitationsResponse = z.output<
  typeof workspaceInvitationsResponseSchema
>;
export type WorkspaceInvitationsQuery = z.input<
  typeof workspaceInvitationsQuerySchema
>;
export type InvitationAcceptanceResolveRequest = z.input<
  typeof invitationAcceptanceResolveRequestSchema
>;
export type InvitationAcceptanceCompleteRequest = z.input<
  typeof invitationAcceptanceCompleteRequestSchema
>;
export type InvitationAcceptanceJourney = z.output<
  typeof invitationAcceptanceJourneySchema
>;
export type InvitationAcceptanceReceipt = z.output<
  typeof invitationAcceptanceReceiptSchema
>;
export type WorkspaceMembersResponse = z.output<
  typeof workspaceMembersResponseSchema
>;
export type AccessibleWorkspace = z.output<typeof accessibleWorkspaceSchema>;
export type AccessibleWorkspacesResponse = z.output<
  typeof accessibleWorkspacesResponseSchema
>;
export type WorkspaceLifecycleOperationResponse = z.output<
  typeof workspaceLifecycleOperationResponseSchema
>;
