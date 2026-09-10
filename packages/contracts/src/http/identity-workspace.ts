import { z } from 'zod';

export { idempotencyKeySchema } from './transport-headers.js';

export const oidcAuthorizationCodeSchema = z.string().min(1).max(4_096);
export const oidcStateSchema = z.string().min(16).max(512);
export const oidcCallbackRequestSchema = z
  .object({ code: oidcAuthorizationCodeSchema, state: oidcStateSchema })
  .strict();
export const oidcStartResponseSchema = z
  .object({ authorizationUrl: z.url(), expiresAt: z.iso.datetime() })
  .strict();
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
export const workspaceMemberSchema = z
  .object({
    userId: z.uuid(),
    email: z.string().trim().min(3).max(320),
    displayName: z.string().trim().min(1).max(256),
    role: z.enum(['owner', 'admin', 'builder', 'operator', 'viewer']),
    membershipStatus: z.enum(['active', 'suspended']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
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
export type UserProfileResponse = z.output<typeof userProfileResponseSchema>;
export type WorkspaceMember = z.output<typeof workspaceMemberSchema>;
export type WorkspaceMembersResponse = z.output<
  typeof workspaceMembersResponseSchema
>;
export type WorkspaceLifecycleOperationResponse = z.output<
  typeof workspaceLifecycleOperationResponseSchema
>;
