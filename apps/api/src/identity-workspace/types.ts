export {
  accessibleWorkspacesQuerySchema,
  accessibleWorkspacesResponseSchema,
  idempotencyKeySchema,
  invitationAcceptanceCompleteRequestSchema,
  invitationAcceptanceJourneySchema,
  invitationAcceptanceOidcRequestSchema,
  invitationAcceptanceReceiptSchema,
  invitationAcceptanceResolveRequestSchema,
  workspaceInvitationCommandRequestSchema,
  workspaceInvitationCommandResponseSchema,
  workspaceInvitationCreateRequestSchema,
  workspaceInvitationParamsSchema,
  workspaceInvitationsQuerySchema,
  workspaceInvitationsResponseSchema,
  oidcCallbackRequestSchema,
  oidcStartResponseSchema,
  workspaceCreateRequestSchema,
  workspaceRenameRequestSchema,
  workspaceRenameResponseSchema,
  workspaceDeletionRequestSchema,
  workspaceIdParamSchema,
  workspaceLifecycleOperationParamsSchema,
  workspaceLifecycleOperationResponseSchema,
  workspaceMembersQuerySchema,
  workspaceMembersResponseSchema,
  workspaceMemberRoleParamsSchema,
  workspaceMemberRoleChangeRequestSchema,
  workspaceMemberRoleChangeResponseSchema,
  userProfileResponseSchema,
  workspaceResponseSchema,
  type WorkspaceLifecycleOperationResponse,
  type AccessibleWorkspacesResponse,
  type WorkspaceResponse,
  type WorkspaceRenameResponse,
  type UserProfileResponse,
  type WorkspaceMembersResponse,
  type WorkspaceMemberRoleChangeResponse,
  type WorkspaceInvitationCommandResponse,
  type WorkspaceInvitationsResponse,
  type InvitationAcceptanceJourney,
  type InvitationAcceptanceReceipt,
} from '@pertexo/contracts/identity-workspace';
import type { AuthorizedWorkspaceContext } from '../workspaces/index.js';

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
  query?: unknown;
  identitySession?: AuthenticatedRequestSession;
  reauthorizeIdentitySession?: (
    signal: AbortSignal,
  ) => Promise<AuthenticatedRequestSession>;
  authorizedWorkspace?: AuthorizedWorkspaceContext;
}

export interface AuthenticatedRequestSession {
  readonly userId: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly clientMetadata: Readonly<Record<string, string>>;
}
