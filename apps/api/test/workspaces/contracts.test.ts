import { describe, expect, it } from 'vitest';
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
  socialSignInStartSchema,
  socialSignInStartedSchema,
  auditFilterSchema,
  auditQuerySchema,
  auditPageSchema,
  governanceSettingsSchema,
  governanceUpdateSchema,
  workspaceVariablesResponseSchema,
  workspaceVariablesRequestSchema,
  workspaceVariablesCommandResponseSchema,
  workspaceVariableUsageResponseSchema,
  apiTokenCreateRequestSchema,
  apiTokenCreateResponseSchema,
  apiTokenInfoResponseSchema,
  apiTokenListResponseSchema,
  apiTokenRevokeRequestSchema,
  apiTokenRevokeResponseSchema,
  apiProblemSchema,
} from '@pertexo/contracts';
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
  identityWorkspaceOpenApiDocument,
} from '../../src/workspaces/index.js';
import { jsonSchema as generated } from '@pertexo/contracts/server';

type DocumentedOperation = Readonly<{
  requestBody: Readonly<{
    content: Readonly<{ 'application/json': Readonly<{ schema: unknown }> }>;
  }>;
  responses: Readonly<Record<string, unknown>>;
  parameters: readonly unknown[];
}>;

/** One operation of the document, which builds most of its paths from declarations. */
function operation(path: string, method: string): DocumentedOperation {
  const paths = identityWorkspaceOpenApiDocument.paths as Readonly<
    Record<string, Readonly<Record<string, unknown>> | undefined>
  >;
  const found = paths[path]?.[method];
  if (found === undefined)
    throw new Error(`${method} ${path} isn't documented`);
  return found as DocumentedOperation;
}

describe('identity/workspace generated contracts', () => {
  it('keeps identity client schemas mechanically aligned with their owning Zod contracts', () => {
    const identitySchemas = Object.fromEntries(
      Object.entries(
        identityWorkspaceOpenApiDocument.components.schemas,
      ).filter(([name]) => !name.startsWith('DataTable')),
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
        ApiTokenInfoResponse: generated(apiTokenInfoResponseSchema, 'output'),
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

  it('documents identity requests, responses and headers', () => {
    expect(identityWorkspaceOpenApiDocument.openapi).toBe('3.1.0');
    expect(
      operation('/v1/workspaces', 'post').requestBody.content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/WorkspaceCreateRequest' });
    expect(
      operation('/v1/workspaces/{workspaceId}', 'patch').requestBody.content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/WorkspaceRenameRequest' });
    expect(
      operation('/v1/workspaces/{workspaceId}', 'patch').responses['412'],
    ).toMatchObject({
      description: 'Workspace revision changed',
      content: {
        'application/problem+json': {
          schema: { $ref: '#/components/schemas/ApiProblem' },
        },
      },
    });
    expect(
      operation('/v1/workspaces/{workspaceId}/deletion', 'post').requestBody
        .content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/WorkspaceDeletionRequest' });
    expect(
      operation('/v1/workspaces/{workspaceId}/deletion', 'post').responses[
        '200'
      ],
    ).toMatchObject({
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/WorkspaceLifecycleChangeResponse',
          },
        },
      },
    });
    expect(
      identityWorkspaceOpenApiDocument.components.securitySchemes.cookieSession,
    ).toEqual({
      type: 'apiKey',
      in: 'cookie',
      name: 'pertexo_session',
    });
    expect(operation('/v1/workspaces', 'post').parameters).toContainEqual(
      expect.objectContaining({ in: 'header', name: 'x-csrf-token' }),
    );
    expect(operation('/v1/workspaces', 'post').parameters).toContainEqual(
      expect.objectContaining({ in: 'header', name: 'Idempotency-Key' }),
    );
    expect(operation('/v1/auth/logout', 'post').parameters).not.toContainEqual(
      expect.objectContaining({ in: 'header', name: 'Idempotency-Key' }),
    );
  });

  it('preserves strict writes', () => {
    const schemas = identityWorkspaceOpenApiDocument.components
      .schemas as Readonly<Record<string, unknown>>;
    const create = schemas.WorkspaceCreateRequest;
    const deletion = schemas.WorkspaceDeletionRequest;

    expect(create).toMatchObject({
      additionalProperties: false,
      required: ['name', 'slug'],
      properties: {
        name: { maxLength: 128, minLength: 1 },
        slug: { maxLength: 64, minLength: 1 },
      },
    });
    expect(deletion).toMatchObject({
      additionalProperties: false,
      required: ['reason'],
      properties: { reason: { maxLength: 512, minLength: 1 } },
    });
  });
});
