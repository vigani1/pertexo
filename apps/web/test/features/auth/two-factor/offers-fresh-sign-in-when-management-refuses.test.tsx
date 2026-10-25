import { LoginPage } from '@/features/auth/pages/login';

import { createApiClient } from '@/lib/api/client';

import { screen, waitFor } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it, vi } from 'vitest';

import { problem, user } from '../../../support/fixtures/team';

import { mockServer } from '../../../support/mock-server';

import { testFetch } from '../../../support/render-app';

import { renderInRouter } from '../../../support/render-in-router';

import { account, identity, openSecurity, password } from './fixture';

describe('two-factor account controls', () => {
  it('offers fresh sign-in when management refuses an old session', async () => {
    identity(() => account());
    mockServer.use(
      http.post('http://pertexo.test/v1/auth/two-factor/enable', () =>
        problem(403, 'identity.session_not_fresh'),
      ),
    );
    const { actor } = await openSecurity();
    await actor.click(
      await screen.findByRole('button', { name: 'Turn on two-factor sign-in' }),
    );
    await password(actor, 'Continue');
    expect(
      await screen.findByRole('link', { name: 'Sign in again' }),
    ).toBeVisible();
    expect(
      screen.getByLabelText('Current password', {
        selector: '#two-factor-password',
      }),
    ).toHaveValue('');
  });
});

describe('two-factor sign-in challenge', () => {
  it('waits for a code before entering, distinguishes lockout and accepts a recovery code', async () => {
    let authenticated = false;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        authenticated
          ? HttpResponse.json(user)
          : problem(401, 'auth.unauthenticated'),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get('http://pertexo.test/v1/auth/capabilities', () =>
        HttpResponse.json({
          password: {
            enabled: true,
            minimumLength: 12,
            verificationRequired: true,
          },
          socialProviders: [],
        }),
      ),
      http.post('http://pertexo.test/v1/auth/sign-in/email', () =>
        HttpResponse.json({
          twoFactorRedirect: true,
          twoFactorMethods: ['totp'],
        }),
      ),
      http.post('http://pertexo.test/v1/auth/two-factor/verify-totp', () =>
        problem(429, 'auth.two_factor_locked'),
      ),
      http.post(
        'http://pertexo.test/v1/auth/two-factor/verify-backup-code',
        async ({ request }) => {
          expect(await request.json()).toEqual({ code: 'recovery-00000' });
          authenticated = true;
          return HttpResponse.json({ user: { id: user.id } });
        },
      ),
    );
    const actor = userEvent.setup();
    const authenticatedCallback = vi.fn();
    renderInRouter(
      <LoginPage
        apiClient={createApiClient({
          fetch: testFetch,
          readCsrfToken: () => undefined,
        })}
        onAuthenticated={authenticatedCallback}
      />,
    );
    await actor.type(await screen.findByLabelText('Email'), user.email);
    await actor.type(
      screen.getByLabelText('Password'),
      'correct horse battery staple',
    );
    await actor.click(screen.getByRole('button', { name: 'Sign in' }));
    const code = await screen.findByLabelText('Authenticator code');
    expect(code).toHaveFocus();
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(authenticatedCallback).not.toHaveBeenCalled();
    await actor.type(code, '123 456');
    await actor.click(screen.getByRole('button', { name: 'Verify code' }));
    expect(
      await screen.findByText('Too many wrong codes. Try again in 15 minutes.'),
    ).toBeVisible();
    await actor.click(
      screen.getByRole('button', { name: 'Use a recovery code instead' }),
    );
    await actor.type(screen.getByLabelText('Recovery code'), 'recovery-00000');
    await actor.click(screen.getByRole('button', { name: 'Verify code' }));
    await waitFor(() => {
      expect(authenticatedCallback).toHaveBeenCalledOnce();
    });
  });
});
