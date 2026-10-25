import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

import { problem, user } from './fixture';

describe('authentication and workspace entry', () => {
  it('manages token-free account sessions and rotates a password with session CSRF', async () => {
    const secondSessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    let passwordChanged = false;
    let emailChangeRequested = false;
    let revokedSession: string | undefined;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/auth/account-security', () =>
        HttpResponse.json({
          email: user.email,
          emailVerified: true,
          availableProviders: [],
          twoFactor: { enabled: false, recoveryCodesRemaining: null },
          methods: [
            {
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              kind: 'password',
              provider: null,
            },
          ],
        }),
      ),
      http.get('http://pertexo.test/v1/auth/account-security/sessions', () =>
        HttpResponse.json({
          items: [
            {
              id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              current: true,
              createdAt: '2026-09-22T10:00:00.000Z',
              updatedAt: '2026-09-22T11:00:00.000Z',
              expiresAt: '2026-09-29T10:00:00.000Z',
              ipAddress: null,
              userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
            },
            ...(revokedSession === secondSessionId
              ? []
              : [
                  {
                    id: secondSessionId,
                    current: false,
                    createdAt: '2026-09-21T10:00:00.000Z',
                    updatedAt: '2026-09-21T11:00:00.000Z',
                    expiresAt: '2026-09-28T10:00:00.000Z',
                    ipAddress: '192.0.2.10',
                    userAgent:
                      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
                  },
                ]),
          ],
        }),
      ),
      http.post(
        'http://pertexo.test/v1/auth/account-security/sessions/revoke',
        async ({ request }) => {
          expect(request.headers.get('x-csrf-token')).toBe(
            'csrf-token-for-component-tests-12345678901234567890',
          );
          const body = (await request.json()) as { sessionId: string };
          revokedSession = body.sessionId;
          return HttpResponse.json({ revoked: true });
        },
      ),
      http.post(
        'http://pertexo.test/v1/auth/account-security/password/change',
        async ({ request }) => {
          expect(request.headers.get('x-csrf-token')).toBe(
            'csrf-token-for-component-tests-12345678901234567890',
          );
          const body = (await request.json()) as {
            currentPassword: string;
            newPassword: string;
          };
          expect(body).toEqual({
            currentPassword: 'current secure password',
            newPassword: 'replacement secure password',
          });
          passwordChanged = true;
          return HttpResponse.json({ changed: true });
        },
      ),
      http.post(
        'http://pertexo.test/v1/auth/change-email',
        async ({ request }) => {
          expect(request.headers.get('x-csrf-token')).toBe(
            'csrf-token-for-component-tests-12345678901234567890',
          );
          expect(await request.json()).toEqual({
            newEmail: 'new.operator@example.test',
            callbackURL: '/login?emailChanged=true',
          });
          emailChangeRequested = true;
          return HttpResponse.json({ status: true });
        },
      ),
    );

    renderApp('/account/security', { strict: true });
    expect(
      await screen.findByRole('heading', { name: 'Account & security' }),
    ).toBeVisible();
    const actor = userEvent.setup();
    await actor.click(screen.getByRole('tab', { name: 'Sessions' }));
    expect(await screen.findByText('Firefox on Windows')).toBeVisible();
    expect(screen.getByText('Chrome on macOS')).toBeVisible();
    expect(screen.getByText('This device')).toBeVisible();
    expect(screen.getByText('192.0.2.10')).toBeVisible();
    expect(screen.queryByText(/Mozilla/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/pertexo_session/iu)).not.toBeInTheDocument();

    const signOutOther = () =>
      screen.getByRole('button', { name: 'Sign out Firefox on Windows' });
    await actor.click(signOutOther());
    expect(revokedSession).toBeUndefined();
    await actor.click(
      within(screen.getByRole('dialog', { name: /\?$/u })).getByRole('button', {
        name: 'Cancel',
      }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: /\?$/u }),
      ).not.toBeInTheDocument();
    });
    expect(revokedSession).toBeUndefined();
    await actor.click(signOutOther());
    await actor.click(
      within(screen.getByRole('dialog', { name: /\?$/u })).getByRole('button', {
        name: 'Sign out',
      }),
    );
    await waitFor(() => {
      expect(revokedSession).toBe(secondSessionId);
    });
    await waitFor(() => {
      expect(screen.queryByText('Firefox on Windows')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: /\?$/u }),
      ).not.toBeInTheDocument();
    });
    expect(
      await screen.findByText('Signed out of Firefox on Windows'),
    ).toBeVisible();

    await actor.click(screen.getByRole('tab', { name: 'Sign-in & security' }));
    await actor.type(
      await screen.findByLabelText('Current password'),
      'current secure password',
    );
    await actor.type(
      screen.getByLabelText('New password'),
      'replacement secure password',
    );
    await actor.type(
      screen.getByLabelText('Confirm new password'),
      'replacement secure password',
    );
    await actor.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => {
      expect(passwordChanged).toBe(true);
    });
    expect(await screen.findByText('Password changed')).toBeVisible();
    expect(screen.getByLabelText('Current password')).toHaveValue('');

    await actor.click(screen.getByRole('tab', { name: 'Profile' }));
    expect(await screen.findByText('Verified')).toBeVisible();
    await actor.type(
      screen.getByLabelText('New email'),
      'new.operator@example.test',
    );
    await actor.click(screen.getByRole('button', { name: 'Change email' }));
    await waitFor(() => {
      expect(emailChangeRequested).toBe(true);
    });
    expect(await screen.findByText(/Check your current inbox/u)).toBeVisible();
  }, 15_000);
  it('asks for a fresh sign-in when an email change needs one', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/auth/account-security', () =>
        HttpResponse.json({
          email: user.email,
          emailVerified: true,
          availableProviders: [],
          twoFactor: { enabled: false, recoveryCodesRemaining: null },
          methods: [
            {
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              kind: 'password',
              provider: null,
            },
          ],
        }),
      ),
      http.post('http://pertexo.test/v1/auth/change-email', () =>
        problem(403, 'auth.forbidden', 'Forbidden'),
      ),
    );
    renderApp('/account/security');
    const actor = userEvent.setup();
    const email = await screen.findByLabelText('New email');
    await actor.type(email, user.email);
    await actor.click(screen.getByRole('button', { name: 'Change email' }));
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/That’s your current email/u)).toBeVisible();
    await actor.clear(email);
    await actor.type(email, 'new.operator@example.test');
    await actor.click(screen.getByRole('button', { name: 'Change email' }));
    expect(
      await screen.findByText(/For your security, sign in again/u),
    ).toBeVisible();
    // The fresh sign-in comes back to this page.
    expect(screen.getByRole('link', { name: 'Sign in again' })).toHaveAttribute(
      'href',
      '/logout?returnTo=%2Faccount%2Fsecurity',
    );
  });
  it('shows truthful linking return feedback alongside authoritative methods', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/auth/account-security', () =>
        HttpResponse.json({
          email: user.email,
          emailVerified: true,
          availableProviders: ['google'],
          twoFactor: { enabled: false, recoveryCodesRemaining: null },
          methods: [
            {
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              kind: 'password',
              provider: null,
            },
            {
              id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
              kind: 'social',
              provider: 'google',
            },
          ],
        }),
      ),
      http.get('http://pertexo.test/v1/auth/account-security/sessions', () =>
        HttpResponse.json({ items: [] }),
      ),
    );
    renderApp('/account/security?linked=true');
    expect(
      await screen.findByText(/You’re back from the provider/u),
    ).toBeVisible();
    expect(await screen.findByText('Google')).toBeVisible();
    expect(
      screen.queryByText(/was linked successfully/iu),
    ).not.toBeInTheDocument();
  });
});
