import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createQueryClient } from '@/app/query-client';
import { createApiClient } from '@/lib/api/client';
import { LoginPage } from '@/features/auth/login-page';
import { endBrowserSession } from '@/features/auth/session-actions';
import { mockServer } from '../support/mock-server';
import { renderApp, testFetch } from '../support/render-app';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const user = {
  id: userId,
  email: 'operator@example.test',
  displayName: 'Pertexo Operator',
  status: 'active',
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};
const workspace = {
  id: workspaceId,
  name: 'Control Operations',
  slug: 'control-operations',
  status: 'active',
  role: 'owner',
  capabilities: ['workspace:read', 'workspace:manage'],
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};

function problem(status: number, code: string, title: string) {
  return HttpResponse.json(
    {
      type: `https://pertexo.test/problems/${code}`,
      title,
      status,
      code,
      requestId: 'request-test-1234',
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

function authenticatedHandlers() {
  return [
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items: [workspace], nextCursor: null }),
    ),
    http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/workflows`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get('http://pertexo.test/v1/node-definitions', () =>
      HttpResponse.json({
        schemaVersion: 1,
        release: {
          epoch: 1,
          fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
        },
        items: [],
      }),
    ),
    http.get('http://pertexo.test/v1/integrations', () =>
      HttpResponse.json({
        schemaVersion: 1,
        release: {
          epoch: 1,
          fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
        },
        items: [],
      }),
    ),
    http.get(
      `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
      () => HttpResponse.json({ items: [], nextCursor: null }),
    ),
  ];
}

describe('authentication and workspace entry', () => {
  it('redirects an unauthenticated root visit to the provider-only login', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        problem(401, 'auth.unauthenticated', 'Authentication required'),
      ),
    );
    renderApp('/');
    expect(
      await screen.findByRole('heading', { name: 'Sign in to continue' }),
    ).toBeVisible();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });

  it('starts OIDC once and hands the validated provider URL to navigation', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/auth/oidc/start', () =>
        HttpResponse.json({
          authorizationUrl:
            'https://identity.example.test/authorize?state=safe',
          expiresAt: '2026-09-14T10:05:00.000Z',
        }),
      ),
    );
    const navigate = vi.fn();
    const queryClient = createQueryClient();
    const apiClient = createApiClient({
      fetch: testFetch,
      readCsrfToken: () => undefined,
    });
    render(
      <QueryClientProvider client={queryClient}>
        <LoginPage apiClient={apiClient} navigateToProvider={navigate} />
      </QueryClientProvider>,
    );
    const continueButton = screen.getByRole('button', {
      name: 'Continue with SSO',
    });
    await userEvent.setup().click(continueButton);
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(
        'https://identity.example.test/authorize?state=safe',
      );
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(continueButton).toBeDisabled();
  });

  it('keeps login recovery inline when the identity provider cannot start', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/auth/oidc/start', () =>
        problem(503, 'service.unavailable', 'Identity service unavailable'),
      ),
    );
    const queryClient = createQueryClient();
    const apiClient = createApiClient({
      fetch: testFetch,
      readCsrfToken: () => undefined,
    });
    render(
      <QueryClientProvider client={queryClient}>
        <LoginPage apiClient={apiClient} navigateToProvider={vi.fn()} />
      </QueryClientProvider>,
    );

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Continue with SSO' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The session could not be started. Try again.',
    );
    expect(
      screen.getByRole('button', { name: 'Continue with SSO' }),
    ).toBeEnabled();
  });

  it('refuses a provider redirect with an unsafe scheme', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/auth/oidc/start', () =>
        HttpResponse.json({
          authorizationUrl: 'javascript:alert(1)',
          expiresAt: '2026-09-14T10:05:00.000Z',
        }),
      ),
    );
    const navigate = vi.fn();
    const queryClient = createQueryClient();
    const apiClient = createApiClient({
      fetch: testFetch,
      readCsrfToken: () => undefined,
    });
    render(
      <QueryClientProvider client={queryClient}>
        <LoginPage apiClient={apiClient} navigateToProvider={navigate} />
      </QueryClientProvider>,
    );

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Continue with SSO' }));

    expect(await screen.findByRole('alert')).toBeVisible();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('lists server-authorized workspaces and enters one through a URL-owned scope', async () => {
    mockServer.use(...authenticatedHandlers());
    const app = renderApp('/workspaces');
    const entry = await screen.findByRole('button', {
      name: /Control Operations/,
    });
    await userEvent.setup().click(entry);
    expect(
      await screen.findByRole('heading', { name: 'Workflows' }),
    ).toBeVisible();
    expect(app.router.state.location.pathname).toBe(
      `/w/${workspaceId}/workflows`,
    );
    const navigation = screen.getByRole('navigation', {
      name: 'Workspace navigation',
    });
    expect(
      within(navigation).getByRole('link', { name: 'Workflows' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(
      within(navigation).queryByText(/connections/iu),
    ).not.toBeInTheDocument();
    expect(screen.getByText(user.email)).toBeVisible();
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
    expect(entry).toHaveTextContent('Open recovery');
    await userEvent.setup().click(entry);
    expect(
      await screen.findByRole('heading', { name: 'General' }),
    ).toBeVisible();
    expect(app.router.state.location.pathname).toBe(
      `/w/${workspaceId}/settings/general`,
    );
  });

  it('does not expose pending-deletion recovery without manage capability', async () => {
    const deniedWorkspace = {
      ...workspace,
      status: 'pending_deletion',
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
    expect(entry).toHaveTextContent('Deletion pending');
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

  it('traps mobile navigation focus and returns it after Escape', async () => {
    mockServer.use(...authenticatedHandlers());
    renderApp(`/w/${workspaceId}/workflows`);
    await screen.findByRole('heading', { name: 'Workflows' });
    const trigger = screen.getByRole('button', { name: 'Open navigation' });

    await userEvent.setup().click(trigger);
    const drawer = await screen.findByRole('dialog', {
      name: 'Workspace navigation',
    });
    expect(
      within(drawer).getByRole('link', { name: 'Workflows' }),
    ).toBeVisible();
    expect(
      within(drawer).getByRole('button', { name: 'Close navigation' }),
    ).toHaveFocus();

    await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Workspace navigation' }),
      ).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  it('shows a genuine no-membership state without inventing an action', async () => {
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
      await screen.findByRole('heading', { name: 'No workspace access yet' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /create/i }),
    ).not.toBeInTheDocument();
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
        name: 'Pertexo could not load this screen',
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
      await screen.findByRole('heading', { name: 'Choose your workspace' }),
    ).toBeVisible();
  });

  it('rejects an inaccessible deep link without switching to unrelated data', async () => {
    mockServer.use(...authenticatedHandlers());
    const unavailableId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const app = renderApp(`/w/${unavailableId}/workflows`);
    expect(
      await screen.findByRole('heading', {
        name: 'This workspace is not available',
      }),
    ).toBeVisible();
    expect(app.router.state.location.pathname).toBe(
      `/w/${unavailableId}/workflows`,
    );
  });

  it('verifies the session before classifying an invalid workspace deep link', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        problem(401, 'auth.unauthenticated', 'Authentication required'),
      ),
    );
    renderApp('/w/not-a-workspace/workflows');
    expect(
      await screen.findByRole('heading', { name: 'Sign in to continue' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', {
        name: 'This workspace is not available',
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

  it('runs the loader-free logout route once in StrictMode and preserves caches for a deliberate retry', async () => {
    let logoutRequests = 0;
    let workspaceReads = 0;
    let signedOut = false;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        signedOut
          ? problem(401, 'auth.unauthenticated', 'Authentication required')
          : HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () => {
        workspaceReads += 1;
        return problem(
          503,
          'service.unavailable',
          'Workspace service unavailable',
        );
      }),
      http.post('http://pertexo.test/v1/auth/logout', () => {
        logoutRequests += 1;
        if (logoutRequests === 1)
          return problem(503, 'service.unavailable', 'Logout unavailable');
        signedOut = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const app = renderApp('/logout', { strict: true });
    app.queryClient.setQueryData(['protected', 'sentinel'], 'preserved');

    expect(
      await screen.findByRole('heading', {
        name: 'Sign out did not complete',
      }),
    ).toBeVisible();
    expect(logoutRequests).toBe(1);
    expect(workspaceReads).toBe(0);
    expect(app.queryClient.getQueryData(['protected', 'sentinel'])).toBe(
      'preserved',
    );

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Retry sign out' }));
    expect(
      await screen.findByRole('heading', { name: 'Sign in to continue' }),
    ).toBeVisible();
    expect(logoutRequests).toBe(2);
    expect(workspaceReads).toBe(0);
    expect(
      app.queryClient.getQueryData(['protected', 'sentinel']),
    ).toBeUndefined();
  });
});
