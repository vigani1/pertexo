import type { FederationSettings } from '@pertexo/contracts';
export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  providerId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const settings: FederationSettings = {
  configured: true,
  reason: null,
  canManage: true,
  organization: {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    name: 'Example organization',
    revision: 1,
    controlWorkspaceId: workspaceId,
    workspaces: [
      { workspaceId, name: 'Example workspace', defaultRole: 'viewer' },
    ],
    domains: [
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        domain: 'example.test',
        revision: 2,
        verifiedAt: '2026-10-18T00:00:00.000Z',
        requireSso: false,
        challenge: null,
        checks: [],
      },
    ],
    providers: [
      {
        id: providerId,
        kind: 'oidc',
        name: 'Work sign-in',
        issuer: 'https://idp.example.test',
        configuration: {
          clientId: 'existing-client',
          emailClaim: 'email',
          nameClaim: 'name',
          jitEnabled: false,
        },
        enabled: true,
        revision: 1,
        secretConfigured: true,
      },
    ],
  },
};
if (settings.organization === null)
  throw new Error('Missing fixture organization');
export const organization = settings.organization;
export function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });
}
