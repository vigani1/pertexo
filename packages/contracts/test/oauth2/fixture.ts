import { OAUTH2_CALLBACK_PATH } from '../../src/schemas/oauth2-connections.js';

export const consentSettings = {
  grantType: 'authorization_code',
  authorizationUrl: 'https://id.example.com/authorize',
  authorizationParameters: {},
  pkce: 's256',
  tokenUrl: 'https://id.example.com/token',
  clientId: 'pertexo-client',
  scope: 'read write',
  clientAuthentication: 'basic',
  tokenParameters: {},
  requestHosts: { mode: 'any' },
} as const;

export const serverSettings = {
  grantType: 'client_credentials',
  tokenUrl: 'https://id.example.com/token',
  clientId: 'pertexo-client',
  scope: '',
  clientAuthentication: 'body',
  tokenParameters: {},
  requestHosts: { mode: 'listed', hosts: ['api.example.com', '*.example.net'] },
} as const;

export const connectionFields = {
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  providerKey: 'http',
  name: 'Operations API',
  authType: 'oauth2',
  secretVersionId: '00000000-0000-4000-8000-000000000003',
  health: { lastTestedAt: null, lastHealthyAt: null, lastErrorCode: null },
  createdAt: '2026-10-31T10:00:00.000Z',
  updatedAt: '2026-10-31T10:00:00.000Z',
  oauth2: {
    settings: consentSettings,
    redirectUri: `https://pertexo.example.com${OAUTH2_CALLBACK_PATH}`,
  },
} as const;

export const grant = {
  authorizedAt: '2026-10-31T10:00:00.000Z',
  accessTokenExpiresAt: null,
  renewable: true,
};
