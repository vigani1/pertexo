import { createQueryClient } from '@/app/query-client';

import { endBrowserSession } from '@/features/auth/model/session/actions';

import { createApiClient } from '@/lib/api/client';

import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import {
  expectSignInPage,
  renderApp,
  testFetch,
} from '../../../support/render-app';

import {
  authenticatedHandlers,
  passwordCapabilities,
  problem,
  user,
  userId,
  workspace,
  workspaceId,
} from './fixture';

describe('authentication and workspace entry', () => {
  it('requires confirmation before removing a sign-in method', async () => {
    const socialMethodId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    let removedMethod: string | undefined;
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
            ...(removedMethod === socialMethodId
              ? []
              : [{ id: socialMethodId, kind: 'social', provider: 'google' }]),
          ],
        }),
      ),
      http.get('http://pertexo.test/v1/auth/account-security/sessions', () =>
        HttpResponse.json({ items: [] }),
      ),
      http.post(
        'http://pertexo.test/v1/auth/account-security/methods/unlink',
        async ({ request }) => {
          const body = (await request.json()) as { methodId: string };
          removedMethod = body.methodId;
          return HttpResponse.json({ unlinked: true });
        },
      ),
    );
    renderApp('/account/security');
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('tab', { name: 'Sign-in & security' }),
    );
    const removeSocial = () =>
      screen.getByRole('button', { name: 'Remove Google' });
    await screen.findByText('Google');
    await actor.click(removeSocial());
    const confirmation = screen.getByRole('dialog', {
      name: 'Remove sign-in method?',
    });
    expect(
      within(confirmation).getByText(/Other devices will be signed out/u),
    ).toBeVisible();
    expect(removedMethod).toBeUndefined();
    await actor.click(
      within(confirmation).getByRole('button', { name: 'Keep method' }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: /\?$/u }),
      ).not.toBeInTheDocument();
    });
    expect(removedMethod).toBeUndefined();
    await actor.click(removeSocial());
    await actor.click(
      within(screen.getByRole('dialog', { name: /\?$/u })).getByRole('button', {
        name: 'Remove method',
      }),
    );
    await waitFor(() => {
      expect(removedMethod).toBe(socialMethodId);
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Remove Google' }),
      ).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: /\?$/u }),
      ).not.toBeInTheDocument();
    });
    // The last way in has no Remove at all, just the reason.
    expect(
      screen.queryByRole('button', { name: 'Remove Password' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Your only way to sign in')).toBeVisible();
  });
  it('routes an eligible pending-deletion workspace to lifecycle recovery', async () => {
    const recoverableWorkspace = {
      ...workspace,
      status: 'pending_deletion',
    };
    mockServer.use(...authenticatedHandlers());
    mockServer.use(
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [recoverableWorkspace], nextCursor: null }),
      ),
    );
    const app = renderApp('/workspaces');
    const entry = await screen.findByRole('button', {
      name: /Control Operations/u,
    });
    expect(entry).toBeEnabled();
    expect(entry).toHaveTextContent('Restore');
    await userEvent.setup().click(entry);
    expect(
      await screen.findByRole('heading', { name: 'Workspace' }),
    ).toBeVisible();
    expect(app.router.state.location.pathname).toBe(
      `/w/${workspaceId}/settings`,
    );
  });
  it('does not expose pending-deletion recovery without manage capability', async () => {
    const deniedWorkspace = {
      ...workspace,
      status: 'pending_deletion',
      revision: 1,
      role: 'viewer',
      capabilities: ['workspace:read'],
    };
    mockServer.use(...authenticatedHandlers());
    mockServer.use(
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [deniedWorkspace], nextCursor: null }),
      ),
    );
    renderApp('/workspaces');
    const entry = await screen.findByRole('button', {
      name: /Control Operations/u,
    });
    expect(entry).toBeDisabled();
    expect(entry).toHaveTextContent('Being deleted');
  });
  it('keeps suspended workspaces unavailable even for managers', async () => {
    mockServer.use(...authenticatedHandlers());
    mockServer.use(
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({
          items: [{ ...workspace, status: 'suspended' }],
          nextCursor: null,
        }),
      ),
    );
    renderApp('/workspaces');
    const entry = await screen.findByRole('button', {
      name: /Control Operations/u,
    });
    expect(entry).toBeDisabled();
    expect(entry).toHaveTextContent('Suspended');
  });
  it('opens the mobile More sheet and returns focus after Escape', async () => {
    mockServer.use(...authenticatedHandlers());
    renderApp(`/w/${workspaceId}/workflows`);
    await screen.findByRole('heading', { name: 'Workflows' });
    const trigger = screen.getByRole('button', { name: 'More' });

    await userEvent.setup().click(trigger);
    const sheet = await screen.findByRole('dialog', { name: 'More' });
    expect(within(sheet).getByRole('link', { name: 'Settings' })).toBeVisible();

    await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'More' }),
      ).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });
  it('offers first-workspace creation from the no-membership state', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    renderApp('/workspaces');
    expect(
      await screen.findByRole('heading', { name: 'Create your workspace' }),
    ).toBeVisible();
    expect(screen.getByLabelText('Workspace name')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Create workspace' }),
    ).toBeVisible();
  });
  it('shows route-level recovery when workspace discovery fails', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        problem(503, 'service.unavailable', 'Workspace service unavailable'),
      ),
    );
    renderApp('/workspaces');

    expect(
      await screen.findByRole('heading', {
        name: 'Something broke on our side',
      }),
    ).toBeVisible();

    mockServer.use(
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [workspace], nextCursor: null }),
      ),
    );
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { name: 'Workspaces' }),
    ).toBeVisible();
  });
  it('rejects an inaccessible deep link without switching to unrelated data', async () => {
    mockServer.use(...authenticatedHandlers());
    const unavailableId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const app = renderApp(`/w/${unavailableId}/workflows`);
    expect(
      await screen.findByRole('heading', {
        name: 'This workspace isn’t available',
      }),
    ).toBeVisible();
    expect(app.router.state.location.pathname).toBe(
      `/w/${unavailableId}/workflows`,
    );
  });
  it('verifies the session before classifying an invalid workspace deep link', async () => {
    mockServer.use(
      passwordCapabilities,
      http.get('http://pertexo.test/v1/users/me', () =>
        problem(401, 'auth.unauthenticated', 'Authentication required'),
      ),
    );
    renderApp('/w/not-a-workspace/workflows');
    await expectSignInPage();
    expect(
      screen.queryByRole('heading', {
        name: 'This workspace isn’t available',
      }),
    ).not.toBeInTheDocument();
  });
  it('cancels scoped reads and clears cached identity data after confirmed logout', async () => {
    let queryCanceled = false;
    mockServer.use(
      http.post(
        'http://pertexo.test/v1/auth/logout',
        () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const queryClient = createQueryClient();
    const apiClient = createApiClient({
      fetch: testFetch,
      readCsrfToken: () =>
        'csrf-token-for-component-tests-12345678901234567890',
    });
    const lateRead = queryClient
      .query({
        queryKey: ['identity', userId, 'late'],
        queryFn: ({ signal }) =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                queryCanceled = true;
                reject(
                  new Error('Scoped query canceled', { cause: signal.reason }),
                );
              },
              { once: true },
            );
          }),
      })
      .catch((error: unknown) => error);
    queryClient.setQueryData(['identity', 'current-user'], user);

    await endBrowserSession(apiClient, queryClient);

    await lateRead;
    expect(queryCanceled).toBe(true);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});
