import { HttpResponse, http } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '@/lib/api/client';
import { LoginPage } from '@/features/auth/login-page';
import { returnPathFrom } from '@/features/auth/return-path.public';
import { mockServer } from '../support/mock-server';
import { renderApp, testFetch } from '../support/render-app';
import { renderInRouter } from '../support/render-in-router';
import { problem, user } from '../support/team-fixtures';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function capabilities() {
  return http.get('http://pertexo.test/v1/auth/capabilities', () =>
    HttpResponse.json({
      password: {
        enabled: true,
        minimumLength: 12,
        verificationRequired: true,
      },
      socialProviders: ['google'],
      legacyMigrationAvailable: false,
    }),
  );
}

describe('sign-in return paths', () => {
  it('keeps only known same-origin app paths', () => {
    for (const path of [
      '/invitations/accept',
      '/account/security',
      `/w/${workspaceId}/account`,
    ])
      expect(returnPathFrom(path)).toBe(path);
    for (const path of [
      'https://evil.example/account/security',
      '//evil.example/account/security',
      '/\\evil.example',
      'javascript:alert(1)',
      '/account/security?next=//evil.example',
      `/w/${workspaceId}/settings`,
      undefined,
      42,
    ])
      expect(returnPathFrom(path)).toBeUndefined();
  });

  it('drops an external or protocol-relative target from the sign-in URL', async () => {
    mockServer.use(
      capabilities(),
      http.get('http://pertexo.test/v1/users/me', () =>
        problem(401, 'auth.unauthenticated'),
      ),
    );
    for (const [target, carried] of [
      ['//evil.example/account/security', '/sign-up'],
      ['https://evil.example/invitations/accept', '/sign-up'],
      ['/account/security', '/sign-up?returnTo=%2Faccount%2Fsecurity'],
    ] as const) {
      const { unmount } = renderApp(
        `/login?returnTo=${encodeURIComponent(target)}`,
      );
      expect(
        await screen.findByRole('link', { name: 'Create an account' }),
      ).toHaveAttribute('href', carried);
      unmount();
    }
  });

  it('never redirects a signed-in visitor to a hostile target', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    const { router } = renderApp(
      `/login?returnTo=${encodeURIComponent('//evil.example/account/security')}`,
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/workspaces');
    });
  });

  it('sends a signed-in visitor straight to the allowed target', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/auth/account-security', () =>
        HttpResponse.json({
          email: user.email,
          emailVerified: true,
          availableProviders: [],
          methods: [],
        }),
      ),
    );
    const { router } = renderApp('/login?returnTo=%2Faccount%2Fsecurity');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/account/security');
    });
  });

  it('returns social sign-in and verification resends to the target', async () => {
    const requests: unknown[] = [];
    mockServer.use(
      capabilities(),
      http.post('*/v1/auth/sign-in/social', async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json({ url: 'https://accounts.example.test/o' });
      }),
    );
    const navigated: string[] = [];
    renderInRouter(
      <LoginPage
        apiClient={createApiClient({
          fetch: testFetch,
          readCsrfToken: () => undefined,
        })}
        returnTo="/account/security"
        navigateToProvider={(url) => {
          navigated.push(url);
        }}
      />,
    );
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: /Google/u }));
    await waitFor(() => {
      expect(navigated).toHaveLength(1);
    });
    expect(requests).toEqual([
      {
        provider: 'google',
        callbackURL: '/account/security',
        errorCallbackURL:
          '/login?socialError=true&returnTo=%2Faccount%2Fsecurity',
      },
    ]);
  });
});
