import { z } from 'zod';

export const oidcAuthorizationCodeSchema = z.string().min(1).max(4_096);
export const oidcStateSchema = z.string().min(16).max(512);
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u)
  .refine((value) => !value.includes(','));
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
export type WorkspaceLifecycleOperationResponse = z.output<
  typeof workspaceLifecycleOperationResponseSchema
>;
