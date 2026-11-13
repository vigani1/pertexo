import { HttpResponse, http } from 'msw';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderLoadedApp } from '../support/render-app';
import {
  createUserFixture,
  createWorkspaceFixture,
} from '../support/fixtures/identity';

const owner = createUserFixture({ email: 'owner@example.test' });
const stranger = createUserFixture({
  id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  email: 'someone.else@example.test',
  displayName: 'Someone Else',
});
const workspace = createWorkspaceFixture({
  capabilities: ['workspace:read', 'variable:manage'],
});
const variables = `http://pertexo.test/v1/workspaces/${workspace.id}/variables`;
const path = `/w/${workspace.id}/settings/variables`;

type Session = 'owner' | 'signed-out' | 'stranger';

function refusal() {
  return HttpResponse.json(
    {
      type: 'about:blank',
      title: 'Session ended',
      status: 401,
      code: 'auth.unauthenticated',
      requestId: 'session-pause',
    },
    {
      status: 401,
      headers: { 'content-type': 'application/problem+json' },
    },
  );
}

/** The server: who the cookie belongs to now, and the writes it accepted. */
function server() {
  const state = { session: 'owner' as Session, writes: [] as unknown[] };
  const accounts = { owner, stranger, 'signed-out': undefined };
  const signedIn = () => accounts[state.session];
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () => {
      const user = signedIn();
      return user === undefined ? refusal() : HttpResponse.json(user);
    }),
    http.get('http://pertexo.test/v1/workspaces', () =>
      signedIn() === undefined
        ? refusal()
        : HttpResponse.json({ items: [workspace], nextCursor: null }),
    ),
    http.get(variables, () =>
      signedIn() === undefined
        ? refusal()
        : HttpResponse.json({
            revision: 1,
            values: { RATE: 10 },
            descriptions: { RATE: 'Rate applied to invoices.' },
          }),
    ),
    http.put(variables, async ({ request }) => {
      if (signedIn() === undefined) return refusal();
      state.writes.push(await request.json());
      return HttpResponse.json({ revision: 2, changed: true, replayed: false });
    }),
  );
  return state;
}

/** Edits RATE and saves it into an expired session. */
async function saveIntoExpiredSession(state: ReturnType<typeof server>) {
  const app = await renderLoadedApp(path);
  const actor = userEvent.setup();
  const row = await screen.findByRole('region', { name: 'RATE' });
  await actor.click(within(row).getByRole('button', { name: 'Edit RATE' }));
  const value = within(row).getByLabelText('Value');
  await actor.clear(value);
  await actor.type(value, '99');
  const description = within(row).getByLabelText('Description (optional)');
  await actor.clear(description);
  await actor.type(description, 'Typed before the session ended');
  state.session = 'signed-out';
  await actor.click(screen.getByRole('button', { name: 'Save variables' }));
  expect(
    await screen.findByRole('heading', { name: 'Your session ended' }),
  ).toBeVisible();
  return { app, actor };
}

afterEach(() => {
  localStorage.clear();
});

describe('a page outside the editor when its session ends', () => {
  it('pauses in place, keeps the typed input and resumes for the same account', async () => {
    const state = server();
    const { app, actor } = await saveIntoExpiredSession(state);

    // The page is kept, hidden, at the same address.
    expect(app.router.state.location.pathname).toBe(path);
    expect(screen.queryByRole('region', { name: 'RATE' })).toBeNull();
    const signIn = screen.getByRole('link', { name: /Sign in again/u });
    expect(signIn).toHaveAttribute('target', '_blank');
    expect(signIn).toHaveAttribute(
      'href',
      `/login?returnTo=${encodeURIComponent(path)}`,
    );

    // Continuing before signing in says so and stays paused.
    await actor.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      await screen.findByText(
        'You’re still signed out here. Finish signing in, then continue.',
      ),
    ).toBeVisible();

    state.session = 'owner';
    await actor.click(screen.getByRole('button', { name: 'Continue' }));
    const row = await screen.findByRole('region', { name: 'RATE' });
    expect(within(row).getByLabelText('Value')).toHaveDisplayValue('99');
    expect(within(row).getByLabelText('Description (optional)')).toHaveValue(
      'Typed before the session ended',
    );
    expect(
      screen.queryByRole('heading', { name: 'Your session ended' }),
    ).toBeNull();

    await actor.click(screen.getByRole('button', { name: 'Save variables' }));
    await waitFor(() => {
      expect(state.writes).toHaveLength(1);
    });
    expect(state.writes[0]).toMatchObject({
      values: { RATE: 99 },
      descriptions: { RATE: 'Typed before the session ended' },
    });
  });

  it('keeps the input when the page’s reads are refused while it waits', async () => {
    const state = server();
    const { app, actor } = await saveIntoExpiredSession(state);
    await act(() =>
      app.queryClient.refetchQueries({
        predicate: (query) => query.queryKey.includes('variables'),
      }),
    );
    state.session = 'owner';
    await actor.click(screen.getByRole('button', { name: 'Continue' }));
    const row = await screen.findByRole('region', { name: 'RATE' });
    expect(within(row).getByLabelText('Value')).toHaveDisplayValue('99');
  });

  it('resumes by itself when the person comes back from signing in', async () => {
    const state = server();
    await saveIntoExpiredSession(state);
    state.session = 'owner';
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    const row = await screen.findByRole('region', { name: 'RATE' });
    expect(within(row).getByLabelText('Value')).toHaveDisplayValue('99');
  });

  it('discards the input and says so when a different account signed in', async () => {
    const state = server();
    const { app, actor } = await saveIntoExpiredSession(state);
    app.queryClient.setQueryData(['protected', owner.id], 'owner’s data');

    state.session = 'stranger';
    await actor.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      await screen.findByText('Signed in as a different account'),
    ).toBeVisible();
    expect(
      screen.getByText(/someone\.else@example\.test.*were discarded/u),
    ).toBeVisible();
    expect(
      app.queryClient.getQueryData(['protected', owner.id]),
    ).toBeUndefined();
    // The page starts again for the account now signed in.
    const row = await screen.findByRole('region', { name: 'RATE' });
    expect(within(row).queryByLabelText('Value')).toBeNull();
    expect(within(row).getByText('10')).toBeVisible();
    expect(state.writes).toHaveLength(0);
  });

  it('leaves for sign-in on request, dropping the kept page', async () => {
    const state = server();
    const { app, actor } = await saveIntoExpiredSession(state);
    await actor.click(
      screen.getByRole('button', { name: 'Discard changes and sign in here' }),
    );
    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe('/login');
    });
    expect(app.router.state.location.search).toEqual({ returnTo: path });
    expect(
      screen.queryByRole('heading', { name: 'Your session ended' }),
    ).toBeNull();
  });

  it.each([
    ['the same account', 'owner', '42'],
    ['another account', 'stranger', '10'],
  ] as const)(
    'hides the page while another tab’s sign-in is checked, then shows it for %s',
    async (_name, session, shown) => {
      const state = server();
      const app = await renderLoadedApp(path);
      const actor = userEvent.setup();
      const row = await screen.findByRole('region', { name: 'RATE' });
      await actor.click(within(row).getByRole('button', { name: 'Edit RATE' }));
      const value = within(row).getByLabelText('Value');
      await actor.clear(value);
      await actor.type(value, '42');
      let answer: (() => void) | undefined;
      const answered = new Promise<void>((resolve) => {
        answer = resolve;
      });
      mockServer.use(
        http.get('http://pertexo.test/v1/users/me', async () => {
          await answered;
          return HttpResponse.json(session === 'owner' ? owner : stranger);
        }),
      );
      state.session = session;
      act(() => {
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: 'pertexo:auth-session-change',
            newValue: JSON.stringify({
              event: 'changed',
              generation: 'other-tab-sign-in',
              sender: 'other-tab',
            }),
          }),
        );
      });
      expect(
        await screen.findByRole('heading', {
          name: 'Checking who’s signed in',
        }),
      ).toBeVisible();
      expect(screen.queryByRole('region', { name: 'RATE' })).toBeNull();
      act(() => {
        answer?.();
      });
      await waitFor(() => {
        expect(
          screen.queryByRole('heading', { name: 'Checking who’s signed in' }),
        ).toBeNull();
      });
      const kept = await screen.findByRole('region', { name: 'RATE' });
      if (session === 'owner')
        expect(within(kept).getByLabelText('Value')).toHaveDisplayValue(shown);
      else expect(within(kept).getByText(shown)).toBeVisible();
      expect(app.router.state.location.pathname).toBe(path);
    },
  );

  it('pauses when a read on the page finds the session gone', async () => {
    const state = server();
    const app = await renderLoadedApp(path);
    await screen.findByRole('region', { name: 'RATE' });
    state.session = 'signed-out';
    await act(() =>
      app.queryClient.refetchQueries({
        predicate: (query) => query.queryKey.includes('variables'),
      }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Your session ended' }),
    ).toBeVisible();
    expect(app.router.state.location.pathname).toBe(path);
  });
});
