import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { apiProblemSchema } from '@pertexo/contracts/errors';

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
  identityWorkspaceOpenApiDocument,
  legacyMethodMigrationStartRequestSchema,
  legacyMethodMigrationStartResponseSchema,
  oidcCallbackRequestSchema,
  oidcStartResponseSchema,
  workspaceCreateRequestSchema,
  workspaceDeletionRequestSchema,
  workspaceLifecycleOperationResponseSchema,
  workspaceMembersResponseSchema,
  workspaceMemberRoleChangeRequestSchema,
  workspaceMemberRoleChangeResponseSchema,
  userProfileResponseSchema,
  workspaceResponseSchema,
  workspaceRenameRequestSchema,
  workspaceRenameResponseSchema,
  workspaceInvitationCreateRequestSchema,
  workspaceInvitationCommandRequestSchema,
  workspaceInvitationCommandResponseSchema,
  workspaceInvitationsResponseSchema,
  invitationAcceptanceResolveRequestSchema,
  invitationAcceptanceOidcRequestSchema,
  invitationAcceptanceCompleteRequestSchema,
  invitationAcceptanceJourneySchema,
  invitationAcceptanceReceiptSchema,
} from '../../src/identity-workspace/index.js';

describe('identity/workspace generated contracts', () => {
  it('projects every client schema mechanically from the owning Zod contract', () => {
    expect(identityWorkspaceClientContract).toEqual({
      schemaVersion: '1.0.0',
      schemas: {
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
        ApiProblem: generated(apiProblemSchema, 'output'),
        AuthenticationCapabilitiesResponse: generated(
          authenticationCapabilitiesResponseSchema,
          'output',
        ),
        LegacyMethodMigrationStartRequest: generated(
          legacyMethodMigrationStartRequestSchema,
          'input',
        ),
        LegacyMethodMigrationStartResponse: generated(
          legacyMethodMigrationStartResponseSchema,
          'output',
        ),
        OidcCallbackRequest: generated(oidcCallbackRequestSchema, 'input'),
        OidcStartResponse: generated(oidcStartResponseSchema, 'output'),
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
        WorkspaceLifecycleOperationResponse: generated(
          workspaceLifecycleOperationResponseSchema,
          'output',
        ),
        WorkspaceResponse: generated(workspaceResponseSchema, 'output'),
        UserProfileResponse: generated(userProfileResponseSchema, 'output'),
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
        InvitationAcceptanceOidcRequest: generated(
          invitationAcceptanceOidcRequestSchema,
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

  it('documents all public route templates and their request/response schemas', () => {
    expect(identityWorkspaceOpenApiDocument.openapi).toBe('3.1.0');
    expect(Object.keys(identityWorkspaceOpenApiDocument.paths)).toEqual([
      '/v1/auth/capabilities',
      '/v1/users/me',
      '/v1/auth/account-security/sessions',
      '/v1/auth/account-security',
      '/v1/auth/account-security/password/change',
      '/v1/auth/account-security/password/setup',
      '/v1/auth/account-security/methods/unlink',
      '/v1/auth/account-security/methods/link/start',
      '/v1/auth/legacy-migration/start',
      '/v1/auth/account-security/sessions/revoke',
      '/v1/auth/account-security/sessions/revoke-others',
      '/v1/auth/oidc/start',
      '/v1/auth/oidc/callback',
      '/v1/auth/logout',
      '/v1/workspaces',
      '/v1/workspaces/{workspaceId}/deletion',
      '/v1/workspaces/{workspaceId}/lifecycle-operations/{operationId}',
      '/v1/workspaces/{workspaceId}/members',
      '/v1/workspaces/{workspaceId}',
      '/v1/workspaces/{workspaceId}/members/{userId}/role',
      '/v1/workspaces/{workspaceId}/invitations',
      '/v1/workspaces/{workspaceId}/invitations/{invitationId}/resend',
      '/v1/workspaces/{workspaceId}/invitations/{invitationId}/revoke',
      '/v1/invitation-acceptance/resolve',
      '/v1/invitation-acceptance',
      '/v1/invitation-acceptance/oidc',
      '/v1/invitation-acceptance/complete',
    ]);
    expect(identityWorkspaceOpenApiDocument.components.schemas).toEqual(
      identityWorkspaceClientContract.schemas,
    );
    expect(
      identityWorkspaceOpenApiDocument.paths['/v1/workspaces'].post.requestBody
        .content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/WorkspaceCreateRequest' });
    expect(
      identityWorkspaceOpenApiDocument.paths['/v1/workspaces/{workspaceId}']
        .patch.requestBody.content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/WorkspaceRenameRequest' });
    expect(
      identityWorkspaceOpenApiDocument.paths['/v1/workspaces/{workspaceId}']
        .patch.responses['412'],
    ).toMatchObject({
      description: 'Workspace revision changed',
      content: {
        'application/problem+json': {
          schema: { $ref: '#/components/schemas/ApiProblem' },
        },
      },
    });
    expect(
      identityWorkspaceOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/deletion'
      ].post.requestBody.content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/WorkspaceDeletionRequest' });
    expect(
      identityWorkspaceOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/deletion'
      ].post.responses['202'],
    ).toMatchObject({
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/WorkspaceLifecycleOperationResponse',
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
    expect(
      identityWorkspaceOpenApiDocument.paths['/v1/workspaces'].post.parameters,
    ).toContainEqual(
      expect.objectContaining({ in: 'header', name: 'x-csrf-token' }),
    );
    expect(
      identityWorkspaceOpenApiDocument.paths['/v1/workspaces'].post.parameters,
    ).toContainEqual(
      expect.objectContaining({ in: 'header', name: 'Idempotency-Key' }),
    );
    expect(
      identityWorkspaceOpenApiDocument.paths['/v1/auth/logout'].post.parameters,
    ).not.toContainEqual(
      expect.objectContaining({ in: 'header', name: 'Idempotency-Key' }),
    );
  });

  it('preserves strict writes and the extension-tolerant bounded callback contract', () => {
    const create =
      identityWorkspaceClientContract.schemas.WorkspaceCreateRequest;
    const deletion =
      identityWorkspaceClientContract.schemas.WorkspaceDeletionRequest;
    const callback =
      identityWorkspaceClientContract.schemas.OidcCallbackRequest;

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
    expect(callback).toMatchObject({
      required: ['code', 'state'],
      properties: {
        code: { maxLength: 4_096, minLength: 1 },
        state: { maxLength: 512, minLength: 16 },
      },
    });
    expect(callback).not.toHaveProperty('additionalProperties');
    expect(
      oidcCallbackRequestSchema.parse({
        code: 'authorization-code',
        state: 'state-value-123456',
        provider_extension: 'ignored',
      }),
    ).toEqual({
      code: 'authorization-code',
      state: 'state-value-123456',
    });
  });
});

function generated(schema: z.ZodType, io: 'input' | 'output') {
  return z.toJSONSchema(schema, { io, target: 'draft-2020-12' });
}
