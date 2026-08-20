import { z } from 'zod';

export const oidcAuthorizationCodeSchema = z.string().min(1).max(4_096);
export const oidcStateSchema = z.string().min(16).max(512);

export const oidcCallbackRequestSchema = z
  .object({
    code: oidcAuthorizationCodeSchema,
    state: oidcStateSchema,
  })
  .strict();

export const oidcStartResponseSchema = z
  .object({
    authorizationUrl: z.url(),
    expiresAt: z.iso.datetime(),
  })
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

export interface CookieResponse {
  header(name: string, value: string | readonly string[]): unknown;
}

export interface IdentityWorkspaceRequest {
  method?: string;
  headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  cookies?: Readonly<Record<string, string | undefined>>;
  requestId?: string;
  traceId?: string;
  params?: unknown;
  identitySession?: AuthenticatedRequestSession;
  authorizedWorkspace?: unknown;
}

export interface AuthenticatedRequestSession {
  userId: string;
  sessionId: string;
  expiresAt: Date;
  clientMetadata: Readonly<Record<string, string>>;
}
