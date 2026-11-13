import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { LinkProviderDialog } from '@/features/auth/components/account/link-provider-dialog';
import { LoginPage } from '@/features/auth/pages/login';
import { createApiClient } from '@/lib/api/client';
import { problem, user } from '../../support/fixtures/team';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
import { renderInRouter } from '../../support/render-in-router';

// PR #705: a refused credential is a 400 with its own code; only a 401
// auth.unauthenticated means the session ended. Each form says which.

const apiClient = () =>
  createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-for-tests-1234',
  });

function signInServer(verifyAnswer?: () => Response) {
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () =>
      problem(401, 'auth.unauthenticated'),
    ),
    http.get('http://pertexo.test/v1/auth/capabilities', () =>
      HttpResponse.json({
        password: {
          enabled: true,
          minimumLength: 12,
          verificationRequired: true,
        },
        socialProviders: [],
        signUp: 'open',
      }),
    ),
    http.post('http://pertexo.test/v1/auth/sign-in/email', () =>
      verifyAnswer === undefined
        ? problem(400, 'auth.invalid_credentials')
        : HttpResponse.json({
            twoFactorRedirect: true,
            twoFactorMethods: ['totp'],
          }),
    ),
    ...(verifyAnswer === undefined
      ? []
      : [
          http.post(
            'http://pertexo.test/v1/auth/two-factor/verify-totp',
            verifyAnswer,
          ),
        ]),
  );
}

async function signIn() {
  const actor = userEvent.setup();
  renderInRouter(
    <LoginPage apiClient={apiClient()} onAuthenticated={vi.fn()} />,
  );
  await actor.type(await screen.findByLabelText('Email'), user.email);
  await actor.type(
    screen.getByLabelText('Password'),
    'correct horse battery staple',
  );
  await actor.click(screen.getByRole('button', { name: 'Sign in' }));
  return actor;
}

describe('refused credentials, each in its own words', () => {
  it('says the email and password don’t match on a 400 refusal', async () => {
    signInServer();
    await signIn();
    expect(
      await screen.findByText(
        'That email and password don’t match. Check them and try again.',
      ),
    ).toBeVisible();
  });

  it.each([
    [
      'auth.two_factor_code_invalid',
      'That code wasn’t accepted. Check it and try again.',
    ],
    [
      'auth.two_factor_challenge_expired',
      'This sign-in expired. Go back and sign in again.',
    ],
  ] as const)(
    'answers a 400 %s at the sign-in code step in its own words',
    async (code, message) => {
      signInServer(() => problem(400, code));
      const actor = await signIn();
      await actor.type(
        await screen.findByLabelText('Authenticator code'),
        '000000',
      );
      await actor.click(screen.getByRole('button', { name: 'Verify code' }));
      expect(await screen.findByText(message)).toBeVisible();
    },
  );

  // Review J6a delta 2 P2: the challenge cookie expires with the challenge,
  // so a sign-in left too long at the code step arrives with no cookie and the
  // API answers auth.unauthenticated. No session exists there yet.
  it('says the sign-in expired when its challenge cookie is gone', async () => {
    signInServer(() => problem(401, 'auth.unauthenticated'));
    const actor = await signIn();
    await actor.type(
      await screen.findByLabelText('Authenticator code'),
      '000000',
    );
    await actor.click(screen.getByRole('button', { name: 'Verify code' }));
    expect(
      await screen.findByText(
        'This sign-in expired. Go back and sign in again.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(/code wasn’t accepted/u)).toBeNull();
  });

  it.each([
    [
      400,
      'auth.invalid_credentials',
      'That didn’t confirm it’s you. Check your current password and try again.',
    ],
    [401, 'auth.unauthenticated', 'Your session ended. Sign in again.'],
    // Only the code ends a session, never the bare status.
    [
      401,
      'auth.invalid_credentials',
      'That didn’t confirm it’s you. Check your current password and try again.',
    ],
  ] as const)(
    'answers a %i %s when adding a sign-in method',
    async (status, code, message) => {
      mockServer.use(
        http.post(
          'http://pertexo.test/v1/auth/account-security/methods/link/start',
          () => problem(status, code),
        ),
      );
      const actor = userEvent.setup();
      renderInRouter(
        <LinkProviderDialog
          apiClient={apiClient()}
          providers={['google']}
          methods={[
            {
              id: 'password-method',
              kind: 'password',
              provider: null,
              createdAt: '2026-11-13T10:00:00.000Z',
            } as never,
          ]}
          onClose={vi.fn()}
          navigateToProvider={vi.fn()}
        />,
      );
      await actor.type(
        await screen.findByLabelText('Current password'),
        'correct horse battery staple',
      );
      await actor.click(screen.getByRole('button', { name: /^Continue/u }));
      expect(await screen.findByText(message)).toBeVisible();
    },
  );
});
