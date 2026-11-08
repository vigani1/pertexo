import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, expect, it, vi } from 'vitest';
import { oauth2ConnectionResponseSchema } from '@pertexo/contracts';
import { OAuth2OverviewActions } from '@/features/connections/components/oauth2/overview-actions';
import { createApiClient } from '@/lib/api/client';
import { renderInRouter } from '../../support/render-in-router';
import { testFetch } from '../../support/render-app';
import { mockServer } from '../../support/mock-server';
import {
  connection,
  connectionId,
  workspaceId,
  userId,
  base,
} from './page/fixture';

const pending = oauth2ConnectionResponseSchema.parse(
  connection('Billing API', {
    providerKey: 'http',
    authType: 'oauth2',
    status: 'reauthorization_required',
    oauth2: {
      settings: {
        grantType: 'authorization_code',
        authorizationUrl: 'https://id.example.test/authorize',
        authorizationParameters: {},
        pkce: 's256',
        tokenUrl: 'https://token.example.test/token',
        clientId: 'client',
        scope: 'read',
        clientAuthentication: 'basic',
        tokenParameters: {},
        requestHosts: { mode: 'any' },
      },
      redirectUri: 'http://pertexo.test/v1/connections/oauth2/callback',
    },
  }),
);
afterEach(() => vi.restoreAllMocks());
it.each(['focus', 'notification'] as const)(
  'recovers the consent completion read after %s without starting consent again',
  async (trigger) => {
    let failing = true;
    let starts = 0;
    vi.spyOn(window, 'open').mockReturnValue(null);
    mockServer.use(
      http.post(`${base}/${connectionId}/oauth2/authorization`, () => {
        starts++;
        return HttpResponse.json({
          kind: 'consent',
          authorizationUrl: 'https://id.example.test/authorize',
          expiresAt: '2027-01-01T00:00:00.000Z',
        });
      }),
      http.get(`${base}/${connectionId}`, () =>
        failing
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.json({
              ...pending,
              status: 'active',
              grant: {
                authorizedAt: '2026-11-08T12:00:00.000Z',
                accessTokenExpiresAt: null,
                renewable: false,
              },
            }),
      ),
    );
    renderInRouter(
      <OAuth2OverviewActions
        scope={{
          apiClient: createApiClient({
            fetch: testFetch,
            readCsrfToken: () =>
              'csrf-token-for-component-tests-12345678901234567890',
          }),
          userId,
          workspaceId,
        }}
        connection={pending}
        canTest
        canManage
        onMode={() => undefined}
      />,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Reconnect' }));
    await screen.findByText('Your browser blocked the window.');
    const channel = new BroadcastChannel('pertexo.connections.oauth2');
    try {
      await act(async () => {
        if (trigger === 'focus') window.dispatchEvent(new Event('focus'));
        else
          channel.postMessage({
            result: 'connected',
            connectionId,
            workspaceId,
          });
        await Promise.resolve();
      });
      const retry = await screen.findByRole('button', {
        name: 'Check connection again',
      });
      expect(
        screen.queryByText('Finish signing in in the window that opened.'),
      ).not.toBeInTheDocument();
      failing = false;
      await user.click(retry);
      expect(await screen.findByText('Connected Billing API')).toBeVisible();
      expect(starts).toBe(1);
    } finally {
      channel.close();
    }
  },
);
