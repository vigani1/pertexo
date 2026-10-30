import { expect, it } from 'vitest';

import {
  identityWorkspaceClientContract,
  identityWorkspaceOpenApiDocument,
} from '../../../src/workspaces/index.js';

export function registerDocumentsAllPublicRouteTemplatesRequest(): void {
  it('documents all public route templates and their request/response schemas', () => {
    expect(identityWorkspaceOpenApiDocument.openapi).toBe('3.1.0');
    expect(Object.keys(identityWorkspaceOpenApiDocument.paths)).toEqual([
      '/v1/workspaces/{workspaceId}/api-tokens',
      '/v1/workspaces/{workspaceId}/api-tokens/{tokenId}/revoke',
      '/v1/workspaces/{workspaceId}/variables',
      '/v1/workspaces/{workspaceId}/variables/usage',
      '/v1/workspaces/{workspaceId}/data-tables',
      '/v1/workspaces/{workspaceId}/data-tables/limits',
      '/v1/workspaces/{workspaceId}/data-tables/{tableId}',
      '/v1/workspaces/{workspaceId}/data-tables/{tableId}/schema',
      '/v1/workspaces/{workspaceId}/data-tables/{tableId}/export',
      '/v1/workspaces/{workspaceId}/data-tables/{tableId}/rows/query',
      '/v1/workspaces/{workspaceId}/data-tables/{tableId}/rows',
      '/v1/workspaces/{workspaceId}/data-tables/{tableId}/import',
      '/v1/workspaces/{workspaceId}/governance/audit',
      '/v1/workspaces/{workspaceId}/governance/settings',
      '/v1/workspaces/{workspaceId}/governance/audit/export',
      '/v1/auth/sign-in/social',
      '/v1/auth/federation/social/callback/{provider}',
      '/v1/auth/federation/social/callback/apple',
      '/v1/auth/capabilities',
      '/v1/users/me',
      '/v1/auth/account-security/sessions',
      '/v1/auth/account-security',
      '/v1/auth/account-security/password/change',
      '/v1/auth/account-security/password/setup',
      '/v1/auth/account-security/methods/unlink',
      '/v1/auth/account-security/methods/link/start',
      '/v1/auth/account-security/sessions/revoke',
      '/v1/auth/account-security/sessions/revoke-others',
      '/v1/auth/logout',
      '/v1/workspaces/{workspaceId}/sso',
      '/v1/workspaces/{workspaceId}/sso/organization',
      '/v1/workspaces/{workspaceId}/sso/workspaces',
      '/v1/workspaces/{workspaceId}/sso/domains',
      '/v1/workspaces/{workspaceId}/sso/domains/{domainId}/verify',
      '/v1/workspaces/{workspaceId}/sso/domains/{domainId}/renew',
      '/v1/workspaces/{workspaceId}/sso/domains/{domainId}/remove',
      '/v1/workspaces/{workspaceId}/sso/domains/{domainId}/enforcement',
      '/v1/workspaces/{workspaceId}/sso/providers',
      '/v1/workspaces/{workspaceId}/sso/providers/{providerId}',
      '/v1/workspaces/{workspaceId}/sso/saml/metadata',
      '/v1/workspaces/{workspaceId}/sso/providers/{providerId}/remove',
      '/v1/auth/federation/discover',
      '/v1/auth/federation/oidc/start',
      '/v1/auth/federation/oidc/test',
      '/v1/auth/federation/oidc/callback',
      '/v1/auth/federation/saml/start',
      '/v1/auth/federation/saml/test',
      '/v1/auth/federation/saml/callback',
      '/v1/workspaces/{workspaceId}/sso/directory',
      '/v1/workspaces/{workspaceId}/sso/directory/people',
      '/v1/workspaces/{workspaceId}/sso/directory/credentials',
      '/v1/workspaces/{workspaceId}/sso/directory/credentials/{credentialId}/revoke',
      '/v1/workspaces/{workspaceId}/sso/directory/mappings',
      '/v1/workspaces/{workspaceId}/sso/directory/adoption',
      '/v1/workspaces/{workspaceId}/sso/directory/adopt',
      '/v1/workspaces/{workspaceId}/sso/directory/workspaces/{targetWorkspaceId}/unlink',
      '/v1/workspaces',
      '/v1/workspaces/{workspaceId}/deletion',
      '/v1/workspaces/{workspaceId}/reactivate',
      '/v1/workspaces/{workspaceId}/members',
      '/v1/workspaces/{workspaceId}',
      '/v1/workspaces/{workspaceId}/members/{userId}/role',
      '/v1/workspaces/{workspaceId}/members/{userId}/remove',
      '/v1/workspaces/{workspaceId}/members/{userId}/suspend',
      '/v1/workspaces/{workspaceId}/members/{userId}/reactivate',
      '/v1/workspaces/{workspaceId}/members/{userId}/transfer-ownership',
      '/v1/workspaces/{workspaceId}/leave',
      '/v1/workspaces/{workspaceId}/invitations',
      '/v1/workspaces/{workspaceId}/invitations/{invitationId}/resend',
      '/v1/workspaces/{workspaceId}/invitations/{invitationId}/revoke',
      '/v1/invitation-acceptance/resolve',
      '/v1/invitation-acceptance',
      '/v1/invitation-acceptance/session',
      '/v1/invitation-acceptance/complete',
    ]);
    expect(
      JSON.parse(
        JSON.stringify(
          identityWorkspaceOpenApiDocument.components.schemas,
        ).replaceAll('#/components/schemas/', '#/schemas/'),
      ),
    ).toEqual(identityWorkspaceClientContract.schemas);
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
      ].post.responses['200'],
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

  it('preserves strict writes', () => {
    const create =
      identityWorkspaceClientContract.schemas.WorkspaceCreateRequest;
    const deletion =
      identityWorkspaceClientContract.schemas.WorkspaceDeletionRequest;

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
}
