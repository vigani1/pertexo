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
    purgeAfter: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export const workspaceIdentifierSchema = z.uuid();
export const workspaceIdParamSchema = z
  .object({ workspaceId: workspaceIdentifierSchema })
  .strict();
export const workspaceResponseSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    status: z.enum(['active', 'suspended', 'pending_deletion', 'deleted']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type WorkspaceResponse = z.output<typeof workspaceResponseSchema>;
