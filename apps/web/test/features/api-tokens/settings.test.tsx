import {
  createUserFixture,
  createWorkspaceFixture,
} from '../../support/fixtures/identity';
import { HttpResponse, http } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ApiTokenMetadata } from '@pertexo/contracts';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const tokenId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const timestamp = '2026-10-14T10:00:00.000Z';
const secret = `ptx_1.${workspaceId}.${tokenId}.${'A'.repeat(43)}`;
const endpoint = `http://pertexo.test/v1/workspaces/${workspaceId}/api-tokens`;
const path = `/w/${workspaceId}/settings/api-tokens`;
const token: ApiTokenMetadata = {
  id: tokenId,
  workspaceId,
  name: 'Build runner',
  scopes: ['run:read', 'workflow:read'],
  status: 'active',
  createdAt: timestamp,
  expiresAt: '2026-11-13T10:00:00.000Z',
  revokedAt: null,
  lastUsedAt: null,
};

function fixtures(
  options: { enabled?: boolean; items?: ApiTokenMetadata[] } = {},
) {
  let items = options.items ?? [];
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () =>
      HttpResponse.json(
        createUserFixture({
          id: userId,
          email: 'owner@example.test',
          displayName: 'Workspace Owner',
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ),
    ),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({
        items: [
          createWorkspaceFixture({
            id: workspaceId,
            name: 'Automation workspace',
            slug: 'automation',
            capabilities: ['workspace:read'],
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        ],
        nextCursor: null,
      }),
    ),
    http.get(endpoint, () =>
      HttpResponse.json({
        items,
        nextCursor: null,
        enabled: options.enabled ?? true,
        availableScopes: ['workflow:read', 'run:read'],
      }),
    ),
  );
  return {
    setItems(next: ApiTokenMetadata[]) {
      items = next;
    },
  };
}
async function fillCreation() {
  const user = userEvent.setup();
  const create = await screen.findByRole('button', { name: 'Create token' });
  await waitFor(() => {
    expect(create).toBeEnabled();
  });
  await user.click(create);
  await user.type(screen.getByLabelText('Token name'), 'Build runner');
  await user.click(screen.getByRole('checkbox', { name: 'Read workflows' }));
  await user.click(screen.getByRole('checkbox', { name: 'Read runs' }));
  return user;
}
function problem(code: string, status: number) {
  return HttpResponse.json(
    {
      type: `https://pertexo.test/problems/${code}`,
      title: 'Request refused',
      status,
      code,
      requestId: 'token-management-test',
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

describe('personal API token settings', () => {
  it('prevents duplicate issuance and discards a late secret after unmount', async () => {
    fixtures();
    let release: (response: Response) => void = () => {
      throw new Error('Response was not held');
    };
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    let creations = 0;
    mockServer.use(
      http.post(endpoint, ({ request }) => {
        creations += 1;
        requestSignal = request.signal;
        return response;
      }),
    );
    const app = renderApp(path);
    const user = await fillCreation();
    const button = screen.getByRole('button', { name: 'Create token' });
    await user.dblClick(button);
    await waitFor(() => {
      expect(creations).toBe(1);
    });
    expect(
      screen.getByRole('button', { name: 'Creating token…' }),
    ).toBeDisabled();
    const scope = screen.getByRole('checkbox', { name: 'Read workflows' });
    await user.click(scope);
    expect(scope).toBeChecked();
    app.unmount();
    expect(requestSignal?.aborted).toBe(true);
    release(HttpResponse.json({ token, secret, replayed: false }));
    await waitFor(() => {
      expect(
        screen.queryByLabelText('API token secret'),
      ).not.toBeInTheDocument();
    });
    expect(
      JSON.stringify(
        app.queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain(secret);
  });
  it('reads metadata through the server cursor without dropping earlier rows', async () => {
    fixtures();
    const afters: (string | null)[] = [];
    mockServer.use(
      http.get(endpoint, ({ request }) => {
        const after = new URL(request.url).searchParams.get('after');
        afters.push(after);
        return HttpResponse.json({
          enabled: true,
          availableScopes: ['workflow:read'],
          items:
            after === null
              ? [token]
              : [{ ...token, id: userId, name: 'Second runner' }],
          nextCursor: after === null ? tokenId : null,
        });
      }),
    );
    renderApp(path);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Load more tokens' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Second runner' }),
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Build runner' })).toBeVisible();
    expect(afters).toEqual([null, tokenId]);
  });
  it('reveals once in local state, clears on Done, and keeps both caches secret-free', async () => {
    const state = fixtures();
    let key: string | null = null;
    mockServer.use(
      http.post(endpoint, async ({ request }) => {
        key = request.headers.get('idempotency-key');
        expect(request.headers.get('x-csrf-token')).toBeTruthy();
        expect(await request.json()).toEqual({
          name: 'Build runner',
          scopes: ['run:read', 'workflow:read'],
          expiresInDays: 30,
        });
        state.setItems([token]);
        return HttpResponse.json(
          { token, secret, replayed: false },
          { status: 201 },
        );
      }),
    );
    const { queryClient } = renderApp(path, { strict: true });
    const user = await fillCreation();
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByLabelText('API token secret')).toHaveValue(
      secret,
    );
    expect(key).toMatch(/^[a-f0-9-]{36}$/u);
    const cache = () =>
      JSON.stringify({
        queries: queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
        mutations: queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => ({
            data: mutation.state.data,
            variables: mutation.state.variables,
          })),
      });
    expect(cache()).not.toContain(secret);
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByLabelText('API token secret')).toBeVisible();
    await user.click(
      screen.getByRole('checkbox', { name: 'I’ve saved this token' }),
    );
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(
        screen.queryByLabelText('API token secret'),
      ).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    expect(screen.getByLabelText('Token name')).toHaveValue('');
    expect(cache()).not.toContain(secret);
  });
  it('recovers an uncertain creation through metadata and never recreates automatically', async () => {
    const state = fixtures();
    let creations = 0;
    mockServer.use(
      http.post(endpoint, () => {
        creations += 1;
        state.setItems([token]);
        return HttpResponse.error();
      }),
    );
    renderApp(path);
    const user = await fillCreation();
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    expect(
      await screen.findByRole('heading', { name: 'Check your tokens' }),
    ).toBeVisible();
    expect(screen.queryByLabelText('API token secret')).not.toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Close and check tokens' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Revoke Build runner' }),
    ).toBeVisible();
    expect(creations).toBe(1);
  });
  it('explains secret-unavailable command replay without attempting another creation', async () => {
    fixtures({ items: [token] });
    let creations = 0;
    mockServer.use(
      http.post(endpoint, () => {
        creations += 1;
        return HttpResponse.json({ token, replayed: true });
      }),
    );
    renderApp(path);
    const user = await fillCreation();
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    expect(
      await screen.findByRole('heading', { name: 'Check your tokens' }),
    ).toBeVisible();
    expect(screen.queryByLabelText('API token secret')).not.toBeInTheDocument();
    expect(creations).toBe(1);
  });
  it('offers recent sign-in with the allowlisted return to this page', async () => {
    fixtures();
    mockServer.use(
      http.post(endpoint, () => problem('auth.session_not_fresh', 403)),
    );
    renderApp(path);
    const user = await fillCreation();
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    expect(
      await screen.findByRole('link', { name: 'Sign in again' }),
    ).toHaveAttribute('href', `/logout?returnTo=${encodeURIComponent(path)}`);
    expect(screen.getByRole('alert')).toHaveTextContent('within five minutes');
  });
  it('explains disabled issuance and still allows revocation with exact-key retry', async () => {
    const state = fixtures({ enabled: false, items: [token] });
    const keys: (string | null)[] = [];
    mockServer.use(
      http.post(`${endpoint}/${tokenId}/revoke`, ({ request }) => {
        keys.push(request.headers.get('idempotency-key'));
        if (keys.length === 1) return HttpResponse.error();
        const revoked: ApiTokenMetadata = {
          ...token,
          status: 'revoked',
          revokedAt: timestamp,
        };
        state.setItems([revoked]);
        return HttpResponse.json({ token: revoked, replayed: false });
      }),
    );
    renderApp(path);
    expect(
      await screen.findByText(/Automation tokens are disabled on this server/u),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: 'Revoke Build runner' }),
    );
    await user.click(screen.getByRole('button', { name: 'Revoke token' }));
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(await screen.findByText('Revoked', { exact: true })).toBeVisible();
  });
  it('shows invalid membership and expiry without offering a secret or reviving grants', async () => {
    fixtures({
      items: [
        { ...token, status: 'membership_changed' },
        {
          ...token,
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          name: 'Old runner',
          status: 'expired',
        },
      ],
    });
    renderApp(path);
    expect(
      await screen.findByText('Membership changed', { exact: true }),
    ).toBeVisible();
    expect(screen.getByText('Expired', { exact: true })).toBeVisible();
    expect(screen.queryByLabelText('API token secret')).not.toBeInTheDocument();
    expect(
      screen.getByText(/Create a replacement with your current access/u),
    ).toBeVisible();
  });
});
