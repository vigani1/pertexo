import { HttpResponse, http } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import { problem } from '../support/team-fixtures';

// A deployment whose own sign-in (Better Auth) is the session authority:
// the invited account is proven by a fresh sign-in, not legacy OIDC.

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const intentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const csrfToken = 'invitation-csrf-token-that-is-long-enough';
const token = `wi1.${workspaceId}.${intentId}.${'a'.repeat(43)}`;
const bound = {
  intentId,
  expiresAt: '2026-09-25T18:00:00.000Z',
  csrfToken,
};

function journeyHandlers(verify: () => Response) {
  const verifications: (string | null)[] = [];
  mockServer.use(
    http.post('http://pertexo.test/v1/invitation-acceptance/resolve', () =>
      HttpResponse.json(
        { ...bound, state: 'sign_in_required' },
        { status: 201 },
      ),
    ),
    http.get('http://pertexo.test/v1/invitation-acceptance', () =>
      HttpResponse.json({ ...bound, state: 'sign_in_required' }),
    ),
    http.post(
      'http://pertexo.test/v1/invitation-acceptance/session',
      ({ request }) => {
        verifications.push(request.headers.get('x-invitation-csrf-token'));
        return verify();
      },
    ),
  );
  return verifications;
}

function openLink() {
  return renderApp(`/invitations/accept#token=${encodeURIComponent(token)}`);
}

describe('invitation acceptance from a session sign-in', () => {
  beforeEach(() => {
    mockServer.use(
      http.get('http://pertexo.test/v1/auth/capabilities', () =>
        HttpResponse.json({
          password: {
            enabled: true,
            minimumLength: 12,
            verificationRequired: true,
          },
          socialProviders: [],
          legacyMigrationAvailable: false,
        }),
      ),
      http.get('http://pertexo.test/v1/users/me', () =>
        problem(401, 'auth.unauthenticated'),
      ),
    );
  });

  it('verifies a fresh sign-in without another click', async () => {
    const verifications = journeyHandlers(() =>
      HttpResponse.json({
        ...bound,
        state: 'ready',
        workspace: { id: workspaceId, name: 'Northwind Ops' },
        role: 'viewer',
        invitationRevision: 1,
        sessionRotationRequired: true,
      }),
    );
    openLink();

    expect(
      await screen.findByRole('button', { name: 'Accept and open workspace' }),
    ).toBeVisible();
    expect(verifications).toEqual([csrfToken]);
  });

  it('sends people without a session to sign in and back', async () => {
    journeyHandlers(() => problem(401, 'auth.unauthenticated'));
    const actor = userEvent.setup();
    const { router } = openLink();

    await actor.click(
      await screen.findByRole('button', { name: 'Sign in to accept' }),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });
    expect(router.state.location.search).toEqual({
      returnTo: '/invitations/accept',
    });
  });

  it('asks an older session to sign in again and come back', async () => {
    journeyHandlers(() => problem(409, 'workspace.invitation_proof_expired'));
    mockServer.use(
      http.post(
        'http://pertexo.test/v1/auth/logout',
        () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const actor = userEvent.setup();
    const { router } = openLink();

    await actor.click(
      await screen.findByRole('button', { name: 'Sign in to accept' }),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });
    expect(router.state.location.search).toEqual({
      returnTo: '/invitations/accept',
    });
  });

  it('creates an account that returns to the invitation', async () => {
    journeyHandlers(() => problem(401, 'auth.unauthenticated'));
    let signUp: unknown;
    mockServer.use(
      http.post(
        'http://pertexo.test/v1/auth/sign-up/email',
        async ({ request }) => {
          signUp = await request.json();
          return HttpResponse.json({ token: null, user: {} });
        },
      ),
    );
    const actor = userEvent.setup();
    const { router } = openLink();

    await actor.click(
      await screen.findByRole('button', {
        name: 'New to Pertexo? Create an account',
      }),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/sign-up');
    });
    await actor.type(await screen.findByLabelText('Your name'), 'New Person');
    await actor.type(screen.getByLabelText('Email'), 'new@example.test');
    await actor.type(
      screen.getByLabelText('Password'),
      'a long enough password',
    );
    await actor.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => {
      expect(signUp).toMatchObject({
        callbackURL: '/login?verified=true&returnTo=%2Finvitations%2Faccept',
      });
    });
  });
});
