import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';
import { createUserFixture } from '../../support/fixtures/identity';

const owner = createUserFixture({ email: 'owner@example.test' });
const stranger = createUserFixture({
  id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  email: 'next.person@example.test',
  displayName: 'Next Person',
});

type Session = 'owner' | 'signed-out' | 'stranger';

function ended() {
  return HttpResponse.json(
    {
      type: 'about:blank',
      title: 'Session ended',
      status: 401,
      code: 'auth.unauthenticated',
      requestId: 'password-session',
    },
    { status: 401, headers: { 'content-type': 'application/problem+json' } },
  );
}

/** The server: who the cookie belongs to now, and each password change it took. */
function server() {
  const state = {
    session: 'owner' as Session,
    changes: [] as { as: Session; body: unknown }[],
  };
  const signedIn = () =>
    ({ owner, stranger, 'signed-out': undefined })[state.session];
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () => {
      const user = signedIn();
      return user === undefined ? ended() : HttpResponse.json(user);
    }),
    http.get('http://pertexo.test/v1/workspaces', () =>
      signedIn() === undefined
        ? ended()
        : HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get('http://pertexo.test/v1/auth/account-security', () => {
      const user = signedIn();
      return user === undefined
        ? ended()
        : HttpResponse.json({
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
          });
    }),
    http.post(
      'http://pertexo.test/v1/auth/account-security/password/change',
      async ({ request }) => {
        state.changes.push({ as: state.session, body: await request.json() });
        return signedIn() === undefined
          ? ended()
          : HttpResponse.json({ changed: true });
      },
    ),
  );
  return state;
}

/** Fills the password form and changes it into an ended session. */
async function changeIntoEndedSession(state: ReturnType<typeof server>) {
  await renderLoadedApp('/account/security');
  const actor = userEvent.setup();
  await actor.click(
    await screen.findByRole('tab', { name: 'Sign-in & security' }),
  );
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
  state.session = 'signed-out';
  await actor.click(screen.getByRole('button', { name: 'Change password' }));
  expect(
    await screen.findByRole('heading', { name: 'Your session ended' }),
  ).toBeVisible();
  return actor;
}

afterEach(() => {
  localStorage.clear();
});

describe('changing a password when the session ends', () => {
  it('keeps all three fields for the same person, and changes it once after resuming', async () => {
    const state = server();
    const actor = await changeIntoEndedSession(state);
    state.session = 'owner';
    await actor.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByLabelText('Current password')).toHaveValue(
      'current secure password',
    );
    expect(screen.getByLabelText('New password')).toHaveValue(
      'replacement secure password',
    );
    expect(screen.getByLabelText('Confirm new password')).toHaveValue(
      'replacement secure password',
    );

    await actor.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Password changed')).toBeVisible();
    expect(state.changes.filter(({ as }) => as === 'owner')).toEqual([
      {
        as: 'owner',
        body: {
          currentPassword: 'current secure password',
          newPassword: 'replacement secure password',
        },
      },
    ]);
  });

  it('empties the form for another person and changes nothing as them', async () => {
    const state = server();
    const actor = await changeIntoEndedSession(state);
    state.session = 'stranger';
    await actor.click(screen.getByRole('button', { name: 'Continue' }));

    expect(
      await screen.findByText('Signed in as a different account'),
    ).toBeVisible();
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: 'Your session ended' }),
      ).toBeNull();
    });
    expect(screen.queryByDisplayValue('current secure password')).toBeNull();
    expect(
      screen.queryByDisplayValue('replacement secure password'),
    ).toBeNull();
    await actor.click(
      await screen.findByRole('tab', { name: 'Sign-in & security' }),
    );
    expect(await screen.findByLabelText('Current password')).toHaveValue('');
    expect(screen.getByLabelText('New password')).toHaveValue('');
    expect(screen.getByLabelText('Confirm new password')).toHaveValue('');
    expect(screen.queryByText('owner@example.test')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(state.changes.filter(({ as }) => as === 'stranger')).toEqual([]);
  });
});
