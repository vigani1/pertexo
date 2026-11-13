import { HttpResponse, http } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiTokenMetadata } from '@pertexo/contracts';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';
import {
  createUserFixture,
  createWorkspaceFixture,
} from '../../support/fixtures/identity';

const owner = createUserFixture({ email: 'owner@example.test' });
const stranger = createUserFixture({
  id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  email: 'next.person@example.test',
  displayName: 'Next Person',
});
const workspace = createWorkspaceFixture({
  name: 'Owner’s automation',
  capabilities: ['workspace:read'],
});
const endpoint = `http://pertexo.test/v1/workspaces/${workspace.id}/api-tokens`;
const path = `/w/${workspace.id}/settings/api-tokens`;
const tokenId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const existing: ApiTokenMetadata = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  workspaceId: workspace.id,
  name: 'Owner’s deploy key',
  scopes: ['workflow:read'],
  status: 'active',
  createdAt: '2026-10-14T10:00:00.000Z',
  expiresAt: '2026-12-13T10:00:00.000Z',
  revokedAt: null,
  lastUsedAt: null,
};

type Session = 'owner' | 'signed-out' | 'stranger';

function problem(code: string, status: number) {
  return HttpResponse.json(
    {
      type: 'about:blank',
      title: 'Request refused',
      status,
      code,
      requestId: 'token-session',
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

/**
 * The server: who the cookie belongs to now, and every create it was sent.
 * Tokens are personal, so a colleague in the workspace lists none of the
 * owner's.
 */
function server(colleague = false) {
  const state = {
    session: 'owner' as Session,
    creates: [] as { as: Session; key: string | null; body: unknown }[],
    created: 0,
  };
  const signedIn = () =>
    ({ owner, stranger, 'signed-out': undefined })[state.session];
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () => {
      const user = signedIn();
      return user === undefined
        ? problem('auth.unauthenticated', 401)
        : HttpResponse.json(user);
    }),
    http.get('http://pertexo.test/v1/workspaces', () => {
      if (state.session === 'signed-out')
        return problem('auth.unauthenticated', 401);
      return HttpResponse.json({
        items: state.session === 'owner' || colleague ? [workspace] : [],
        nextCursor: null,
      });
    }),
    http.get(endpoint, () => {
      if (state.session === 'signed-out')
        return problem('auth.unauthenticated', 401);
      if (state.session === 'stranger' && !colleague)
        return problem('resource.not_found', 404);
      return HttpResponse.json({
        items: state.session === 'owner' ? [existing] : [],
        nextCursor: null,
        enabled: true,
        availableScopes: ['workflow:read', 'run:read'],
      });
    }),
    http.post(endpoint, async ({ request }) => {
      state.creates.push({
        as: state.session,
        key: request.headers.get('idempotency-key'),
        body: await request.json(),
      });
      if (state.session === 'signed-out')
        return problem('auth.unauthenticated', 401);
      if (state.session === 'stranger')
        return problem('resource.not_found', 404);
      state.created += 1;
      return HttpResponse.json(
        {
          token: {
            ...existing,
            id: tokenId,
            name: 'Build runner',
            scopes: ['run:read', 'workflow:read'],
          },
          secret: `ptx_1.${workspace.id}.${tokenId}.${'A'.repeat(43)}`,
          replayed: false,
        },
        { status: 201 },
      );
    }),
  );
  return state;
}

/** Fills the create dialog and creates into an ended session. */
async function createIntoEndedSession(state: ReturnType<typeof server>) {
  await renderLoadedApp(path);
  const actor = userEvent.setup();
  expect(await screen.findByText('Owner’s deploy key')).toBeVisible();
  const open = screen.getByRole('button', { name: 'Create token' });
  await waitFor(() => {
    expect(open).toBeEnabled();
  });
  await actor.click(open);
  await actor.type(screen.getByLabelText('Token name'), 'Build runner');
  await actor.click(screen.getByRole('checkbox', { name: 'Read workflows' }));
  await actor.click(screen.getByRole('checkbox', { name: 'Read runs' }));
  state.session = 'signed-out';
  await actor.click(screen.getByRole('button', { name: 'Create token' }));
  expect(
    await screen.findByRole('heading', { name: 'Your session ended' }),
  ).toBeVisible();
  return actor;
}

afterEach(() => {
  localStorage.clear();
});

describe('creating an API token when the session ends', () => {
  it('keeps the whole form for the same person, and creates one token after resuming', async () => {
    const state = server();
    const actor = await createIntoEndedSession(state);
    state.session = 'owner';
    await actor.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByLabelText('Token name')).toHaveValue(
      'Build runner',
    );
    expect(
      screen.getByRole('checkbox', { name: 'Read workflows' }),
    ).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Read runs' })).toBeChecked();
    expect(state.created).toBe(0);

    await actor.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByLabelText('API token secret')).toBeVisible();
    expect(state.created).toBe(1);
    expect(
      state.creates.filter(({ as }) => as === 'owner').map(({ body }) => body),
    ).toEqual([
      {
        name: 'Build runner',
        scopes: ['run:read', 'workflow:read'],
        expiresInDays: 30,
      },
    ]);
  });

  it.each([
    ['a colleague who can open this page', true],
    ['someone outside the workspace', false],
  ])(
    'discards the form for %s, shows none of the first person’s tokens and creates nothing as them',
    async (_who, colleague) => {
      const state = server(colleague);
      const actor = await createIntoEndedSession(state);
      state.session = 'stranger';
      await actor.click(screen.getByRole('button', { name: 'Continue' }));

      expect(
        await screen.findByText('Signed in as a different account'),
      ).toBeVisible();
      expect(
        screen.getByText(/next\.person@example\.test.*were discarded/u),
      ).toBeVisible();
      await waitFor(() => {
        expect(
          screen.queryByRole('heading', { name: 'Your session ended' }),
        ).toBeNull();
      });
      expect(screen.queryByLabelText('Token name')).toBeNull();
      expect(screen.queryByDisplayValue('Build runner')).toBeNull();
      expect(screen.queryByText('Owner’s deploy key')).toBeNull();
      if (!colleague)
        expect(screen.queryByText('Owner’s automation')).toBeNull();
      // Whatever the paused page held stays unsent under the new person.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(state.creates.filter(({ as }) => as === 'stranger')).toEqual([]);
      expect(state.created).toBe(0);
    },
  );
});
