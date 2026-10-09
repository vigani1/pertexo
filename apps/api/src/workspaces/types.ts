export {
  accessibleWorkspacesQuerySchema,
  accessibleWorkspacesResponseSchema,
  accountSecurityLinkStartRequestSchema,
  accountSecurityLinkStartResponseSchema,
  accountSecurityMethodUnlinkRequestSchema,
  accountSecurityMethodUnlinkResponseSchema,
  accountSecurityPasswordChangeRequestSchema,
  accountSecurityPasswordChangeResponseSchema,
  accountSecurityPasswordSetupRequestSchema,
  accountSecurityPasswordSetupResponseSchema,
  accountSecurityResponseSchema,
  accountSecurityRevokeOthersResponseSchema,
  accountSecuritySessionRevokeRequestSchema,
  accountSecuritySessionRevokeResponseSchema,
  accountSecuritySessionsResponseSchema,
  authenticationCapabilitiesResponseSchema,
  idempotencyKeySchema,
  invitationAcceptanceCompleteRequestSchema,
  invitationAcceptanceJourneySchema,
  invitationAcceptanceReceiptSchema,
  invitationAcceptanceResolveRequestSchema,
  workspaceInvitationCommandRequestSchema,
  workspaceInvitationCommandResponseSchema,
  workspaceInvitationCreateRequestSchema,
  workspaceInvitationParamsSchema,
  workspaceInvitationsQuerySchema,
  workspaceInvitationsResponseSchema,
  workspaceCreateRequestSchema,
  workspaceRenameRequestSchema,
  workspaceRenameResponseSchema,
  workspaceDeletionRequestSchema,
  workspaceIdParamSchema,
  workspaceLifecycleChangeResponseSchema,
  workspaceMembersQuerySchema,
  workspaceMembersResponseSchema,
  workspaceMemberRoleParamsSchema,
  workspaceMemberRoleChangeRequestSchema,
  workspaceMemberRoleChangeResponseSchema,
  workspaceMemberRemovalRequestSchema,
  workspaceMemberRemovalResponseSchema,
  workspaceLeaveRequestSchema,
  workspaceLeaveResponseSchema,
  workspaceMemberStatusRequestSchema,
  workspaceMemberStatusResponseSchema,
  workspaceOwnershipTransferRequestSchema,
  workspaceOwnershipTransferResponseSchema,
  userProfileResponseSchema,
  userProfileUpdateRequestSchema,
  userProfileUpdateResponseSchema,
  invitationAcceptanceSessionRequestSchema,
  workspaceResponseSchema,
  type WorkspaceLifecycleChangeResponse,
  type AccessibleWorkspacesResponse,
  type WorkspaceResponse,
  type WorkspaceRenameResponse,
  type UserProfileResponse,
  type UserProfileUpdateResponse,
  type WorkspaceMemberRemovalResponse,
  type WorkspaceLeaveResponse,
  type WorkspaceMemberStatusResponse,
  type WorkspaceOwnershipTransferResponse,
  type WorkspaceMembersResponse,
  type WorkspaceMemberRoleChangeResponse,
  type WorkspaceInvitationCommandResponse,
  type WorkspaceInvitationsResponse,
  type InvitationAcceptanceJourney,
  type InvitationAcceptanceReceipt,
} from '@pertexo/contracts';
import type { AuthorizedWorkspaceContext } from '../authorization/index.js';

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
