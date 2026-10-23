import {
  directoryAdoptionPreviewSchema,
  directorySettingsSchema,
  directoryPeoplePageSchema,
  directoryCredentialCreateSchema,
  directoryCredentialResultSchema,
  directoryRevisionSchema,
  directoryMappingsSchema,
  directoryAdoptSchema,
  directoryChangedSchema,
} from '@pertexo/contracts';
import {
  federationSettingsSchema,
  samlMetadataSchema,
  federationOrganizationCreateSchema,
  federationWorkspaceLinkSchema,
  federationDomainCreateSchema,
  federationRevisionCommandSchema,
  federationEnforcementSchema,
  federationProviderCreateSchema,
  federationProviderUpdateSchema,
  federationTestStartSchema,
  federationDiscoverySchema,
  federationSignInStartSchema,
  authorizationStartedSchema,
} from '@pertexo/contracts';
import {
  socialSignInStartSchema,
  socialSignInStartedSchema,
  auditFilterSchema,
  auditQuerySchema,
  auditPageSchema,
  governanceSettingsSchema,
  governanceUpdateSchema,
} from '@pertexo/contracts';
import {
  workspaceVariablesResponseSchema,
  workspaceVariablesRequestSchema,
  workspaceVariablesCommandResponseSchema,
  workspaceVariableUsageResponseSchema,
  apiTokenCreateRequestSchema,
  apiTokenCreateResponseSchema,
  apiTokenListResponseSchema,
  apiTokenRevokeRequestSchema,
  apiTokenRevokeResponseSchema,
} from '@pertexo/contracts';
import { expect, it } from 'vitest';

import { apiProblemSchema } from '@pertexo/contracts';
import {
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
  identityWorkspaceClientContract,
  workspaceCreateRequestSchema,
  workspaceDeletionRequestSchema,
  workspaceLifecycleChangeResponseSchema,
  workspaceMembersResponseSchema,
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
  workspaceResponseSchema,
  workspaceRenameRequestSchema,
  workspaceRenameResponseSchema,
  workspaceInvitationCreateRequestSchema,
  workspaceInvitationCommandRequestSchema,
  workspaceInvitationCommandResponseSchema,
  workspaceInvitationsResponseSchema,
  invitationAcceptanceResolveRequestSchema,
  invitationAcceptanceSessionRequestSchema,
  invitationAcceptanceCompleteRequestSchema,
  invitationAcceptanceJourneySchema,
  invitationAcceptanceReceiptSchema,
} from '../../../src/workspaces/index.js';
import { generated } from './fixture.js';

export function registerKeepsIdentityClientSchemasMechanicallyAligned(): void {
  it('keeps identity client schemas mechanically aligned with their owning Zod contracts', () => {
    const identitySchemas = Object.fromEntries(
      Object.entries(identityWorkspaceClientContract.schemas).filter(
        ([name]) => !name.startsWith('DataTable'),
      ),
    );
    expect({ schemas: identitySchemas }).toEqual({
      schemas: {
        DirectoryAdoptionPreview: generated(
          directoryAdoptionPreviewSchema,
          'output',
        ),
        DirectorySettings: generated(directorySettingsSchema, 'output'),
        DirectoryPeoplePage: generated(directoryPeoplePageSchema, 'output'),
        DirectoryCredentialCreate: generated(
          directoryCredentialCreateSchema,
          'input',
        ),
        DirectoryCredentialResult: generated(
          directoryCredentialResultSchema,
          'output',
        ),
        DirectoryRevision: generated(directoryRevisionSchema, 'input'),
        DirectoryMappings: generated(directoryMappingsSchema, 'input'),
        DirectoryAdopt: generated(directoryAdoptSchema, 'input'),
        DirectoryChanged: generated(directoryChangedSchema, 'output'),
        FederationSettings: generated(federationSettingsSchema, 'output'),
        SamlMetadata: generated(samlMetadataSchema, 'output'),
        FederationOrganizationCreate: generated(
          federationOrganizationCreateSchema,
          'input',
        ),
        FederationWorkspaceLink: generated(
          federationWorkspaceLinkSchema,
          'input',
        ),
        FederationDomainCreate: generated(
          federationDomainCreateSchema,
          'input',
        ),
        FederationRevisionCommand: generated(
          federationRevisionCommandSchema,
          'input',
        ),
        FederationEnforcement: generated(federationEnforcementSchema, 'input'),
        FederationProviderCreate: generated(
          federationProviderCreateSchema,
          'input',
        ),
        FederationProviderUpdate: generated(
          federationProviderUpdateSchema,
          'input',
        ),
        FederationTestStart: generated(federationTestStartSchema, 'input'),
        FederationDiscovery: generated(federationDiscoverySchema, 'output'),
        FederationSignInStart: generated(federationSignInStartSchema, 'input'),
        AuthorizationStarted: generated(authorizationStartedSchema, 'output'),

        SocialSignInStart: generated(socialSignInStartSchema, 'input'),
        SocialSignInStarted: generated(socialSignInStartedSchema, 'output'),
        WorkspaceVariablesResponse: generated(
          workspaceVariablesResponseSchema,
          'output',
        ),
        WorkspaceVariablesRequest: generated(
          workspaceVariablesRequestSchema,
          'input',
        ),
        WorkspaceVariablesCommandResponse: generated(
          workspaceVariablesCommandResponseSchema,
          'output',
        ),
        WorkspaceVariableUsageResponse: generated(
          workspaceVariableUsageResponseSchema,
          'output',
        ),
        ApiTokenCreateRequest: generated(apiTokenCreateRequestSchema, 'input'),
        ApiTokenCreateResponse: generated(
          apiTokenCreateResponseSchema,
          'output',
        ),
        ApiTokenListResponse: generated(apiTokenListResponseSchema, 'output'),
        ApiTokenRevokeRequest: generated(apiTokenRevokeRequestSchema, 'input'),
        ApiTokenRevokeResponse: generated(
          apiTokenRevokeResponseSchema,
          'output',
        ),
        AccessibleWorkspacesResponse: generated(
          accessibleWorkspacesResponseSchema,
          'output',
        ),
        AccountSecurityLinkStartRequest: generated(
          accountSecurityLinkStartRequestSchema,
          'input',
        ),
        AccountSecurityLinkStartResponse: generated(
          accountSecurityLinkStartResponseSchema,
          'output',
        ),
        AccountSecurityMethodUnlinkRequest: generated(
          accountSecurityMethodUnlinkRequestSchema,
          'input',
        ),
        AccountSecurityMethodUnlinkResponse: generated(
          accountSecurityMethodUnlinkResponseSchema,
          'output',
        ),
        AccountSecurityPasswordChangeRequest: generated(
          accountSecurityPasswordChangeRequestSchema,
          'input',
        ),
        AccountSecurityPasswordChangeResponse: generated(
          accountSecurityPasswordChangeResponseSchema,
          'output',
        ),
        AccountSecurityPasswordSetupRequest: generated(
          accountSecurityPasswordSetupRequestSchema,
          'input',
        ),
        AccountSecurityPasswordSetupResponse: generated(
          accountSecurityPasswordSetupResponseSchema,
          'output',
        ),
        AccountSecurityResponse: generated(
          accountSecurityResponseSchema,
          'output',
        ),
        AccountSecurityRevokeOthersResponse: generated(
          accountSecurityRevokeOthersResponseSchema,
          'output',
        ),
        AccountSecuritySessionRevokeRequest: generated(
          accountSecuritySessionRevokeRequestSchema,
          'input',
        ),
        AccountSecuritySessionRevokeResponse: generated(
          accountSecuritySessionRevokeResponseSchema,
          'output',
        ),
        AccountSecuritySessionsResponse: generated(
          accountSecuritySessionsResponseSchema,
          'output',
        ),
        AuditFilter: generated(auditFilterSchema, 'input'),
        AuditQuery: generated(auditQuerySchema, 'input'),
        AuditPage: generated(auditPageSchema, 'output'),
        GovernanceSettings: generated(governanceSettingsSchema, 'output'),
        GovernanceUpdate: generated(governanceUpdateSchema, 'input'),
        ApiProblem: generated(apiProblemSchema, 'output'),
        AuthenticationCapabilitiesResponse: generated(
          authenticationCapabilitiesResponseSchema,
          'output',
        ),
        WorkspaceCreateRequest: generated(
          workspaceCreateRequestSchema,
          'input',
        ),
        WorkspaceRenameRequest: generated(
          workspaceRenameRequestSchema,
          'input',
        ),
        WorkspaceRenameResponse: generated(
          workspaceRenameResponseSchema,
          'output',
        ),
        WorkspaceDeletionRequest: generated(
          workspaceDeletionRequestSchema,
          'input',
        ),
        WorkspaceLifecycleChangeResponse: generated(
          workspaceLifecycleChangeResponseSchema,
          'output',
        ),
        WorkspaceResponse: generated(workspaceResponseSchema, 'output'),
        UserProfileResponse: generated(userProfileResponseSchema, 'output'),
        UserProfileUpdateRequest: generated(
          userProfileUpdateRequestSchema,
          'input',
        ),
        UserProfileUpdateResponse: generated(
          userProfileUpdateResponseSchema,
          'output',
        ),
        WorkspaceMembersResponse: generated(
          workspaceMembersResponseSchema,
          'output',
        ),
        WorkspaceMemberRoleChangeRequest: generated(
          workspaceMemberRoleChangeRequestSchema,
          'input',
        ),
        WorkspaceMemberRoleChangeResponse: generated(
          workspaceMemberRoleChangeResponseSchema,
          'output',
        ),
        WorkspaceMemberRemovalRequest: generated(
          workspaceMemberRemovalRequestSchema,
          'input',
        ),
        WorkspaceMemberRemovalResponse: generated(
          workspaceMemberRemovalResponseSchema,
          'output',
        ),
        WorkspaceLeaveRequest: generated(workspaceLeaveRequestSchema, 'input'),
        WorkspaceLeaveResponse: generated(
          workspaceLeaveResponseSchema,
          'output',
        ),
        WorkspaceMemberStatusRequest: generated(
          workspaceMemberStatusRequestSchema,
          'input',
        ),
        WorkspaceMemberStatusResponse: generated(
          workspaceMemberStatusResponseSchema,
          'output',
        ),
        WorkspaceOwnershipTransferRequest: generated(
          workspaceOwnershipTransferRequestSchema,
          'input',
        ),
        WorkspaceOwnershipTransferResponse: generated(
          workspaceOwnershipTransferResponseSchema,
          'output',
        ),
        WorkspaceInvitationCreateRequest: generated(
          workspaceInvitationCreateRequestSchema,
          'input',
        ),
        WorkspaceInvitationCommandRequest: generated(
          workspaceInvitationCommandRequestSchema,
          'input',
        ),
        WorkspaceInvitationCommandResponse: generated(
          workspaceInvitationCommandResponseSchema,
          'output',
        ),
        WorkspaceInvitationsResponse: generated(
          workspaceInvitationsResponseSchema,
          'output',
        ),
        InvitationAcceptanceResolveRequest: generated(
          invitationAcceptanceResolveRequestSchema,
          'input',
        ),
        InvitationAcceptanceSessionRequest: generated(
          invitationAcceptanceSessionRequestSchema,
          'input',
        ),
        InvitationAcceptanceCompleteRequest: generated(
          invitationAcceptanceCompleteRequestSchema,
          'input',
        ),
        InvitationAcceptanceJourney: generated(
          invitationAcceptanceJourneySchema,
          'output',
        ),
        InvitationAcceptanceReceipt: generated(
          invitationAcceptanceReceiptSchema,
          'output',
        ),
      },
    });
  });
}
