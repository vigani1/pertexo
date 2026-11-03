import { screen } from '@testing-library/react';
import { it, expect } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
import {
  connection,
  connectionId,
  detailOf,
  identityHandlers,
  lens,
  listOf,
  workspaceId,
} from './page/fixture';

it.each([null, '2026-11-03T20:00:00.000Z'])(
  'shows actionable renewal recovery for a grant expiring at %s',
  async (expiresAt) => {
    const current = connection('External account B', {
      providerKey: 'http',
      authType: 'oauth2',
      oauth2: {
        redirectUri: 'http://pertexo.test/v1/connections/oauth2/callback',
        settings: {
          grantType: 'authorization_code',
          authorizationUrl: 'https://service.example.test/authorize',
          tokenUrl: 'https://service.example.test/token',
          clientId: 'public-client-id',
          scope: '',
          clientAuthentication: 'basic',
          pkce: 's256',
          authorizationParameters: {},
          tokenParameters: {},
          requestHosts: { mode: 'any' },
        },
      },
      grant: {
        authorizedAt: '2026-11-03T18:00:00.000Z',
        accessTokenExpiresAt: expiresAt,
        renewable: false,
      },
    });
    mockServer.use(
      ...identityHandlers(),
      listOf(() => [current]),
      detailOf(() => current),
    );
    renderApp(`/w/${workspaceId}/connections?connection=${connectionId}`);
    expect(
      await screen.findByRole('heading', { name: 'External account B' }),
    ).toBeVisible();
    expect(
      lens().getByText(
        /revoke this app’s access at the service, then connect again/u,
      ),
    ).toBeVisible();
    expect(lens().getByRole('button', { name: /^Reconnect$/u })).toBeVisible();
    if (expiresAt === null)
      expect(lens().getByText(/The service gave no expiry/u)).toBeVisible();
    else
      expect(lens().getByText(/someone will need to reconnect/u)).toBeVisible();
    expect(
      lens().queryByText('Token renews automatically'),
    ).not.toBeInTheDocument();
  },
);
