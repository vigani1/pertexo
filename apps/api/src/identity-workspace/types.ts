export {
  idempotencyKeySchema,
  oidcAuthorizationCodeSchema,
  oidcCallbackRequestSchema,
  oidcStartResponseSchema,
  oidcStateSchema,
  workspaceCreateRequestSchema,
  workspaceDeletionRequestSchema,
  workspaceIdentifierSchema,
  workspaceIdParamSchema,
  workspaceResponseSchema,
  type WorkspaceResponse,
} from '@pertexo/contracts/identity-workspace';

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
