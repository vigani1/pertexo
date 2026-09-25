import { HttpResponse, http } from 'msw';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { InvitationAcceptancePage } from '@/features/workspace-invitations/invitation-acceptance-page';
import { createApiClient } from '@/lib/api/client';

import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const intentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const csrfToken = 'invitation-csrf-token-that-is-long-enough';
const otherIntentId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function componentApiClient(fetchImplementation = globalThis.fetch) {
  return createApiClient({
    fetch: (input, init) =>
      fetchImplementation(
        typeof input === 'string'
          ? new URL(input, 'http://pertexo.test')
          : input,
        init,
      ),
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
}

describe('invitation acceptance', () => {
  it('removes the fragment token and binds a sign-in journey in StrictMode', async () => {
    let resolvedToken: unknown;
    mockServer.use(
      http.post(
        'http://pertexo.test/v1/invitation-acceptance/resolve',
        async ({ request }) => {
          resolvedToken = await request.json();
          return HttpResponse.json(
            {
              state: 'sign_in_required',
              intentId,
              expiresAt: '2026-09-19T18:00:00.000Z',
              csrfToken,
            },
            { status: 201 },
          );
        },
      ),
    );

    renderApp(
      `/invitations/accept#token=${encodeURIComponent(`wi1.${workspaceId}.${intentId}.${'a'.repeat(43)}`)}`,
      { strict: true },
    );

    expect(
      await screen.findByRole('button', { name: 'Sign in to accept' }),
    ).toBeVisible();
    expect(resolvedToken).toEqual({
      token: `wi1.${workspaceId}.${intentId}.${'a'.repeat(43)}`,
    });
    expect(window.location.hash).toBe('');
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });

  it('retries the same link after the resolver response and cookie are lost', async () => {
    const requests: unknown[] = [];
    let attempt = 0;
    mockServer.use(
      http.post(
        'http://pertexo.test/v1/invitation-acceptance/resolve',
        async ({ request }) => {
          requests.push(await request.json());
          attempt += 1;
          if (attempt === 1) return HttpResponse.error();
          return HttpResponse.json(
            {
              state: 'sign_in_required',
              intentId,
              expiresAt: '2026-09-19T18:00:00.000Z',
              csrfToken,
            },
            { status: 201 },
          );
        },
      ),
    );
    const token = `wi1.${workspaceId}.${intentId}.${'a'.repeat(43)}`;
    const browser = userEvent.setup();
    renderApp(`/invitations/accept#token=${encodeURIComponent(token)}`);

    await browser.click(
      await screen.findByRole('button', { name: 'Try the link again' }),
    );

    expect(
      await screen.findByRole('button', { name: 'Sign in to accept' }),
    ).toBeVisible();
    expect(requests).toEqual([{ token }, { token }]);
  });

  it('retains the exact acceptance command after a lost completion response', async () => {
    const requests: { body: unknown; key: string | null }[] = [];
    let completionCount = 0;
    let completed = false;
    mockServer.use(
      http.post('http://pertexo.test/v1/invitation-acceptance/resolve', () =>
        HttpResponse.json(
          {
            state: 'ready',
            intentId,
            expiresAt: '2026-09-19T18:00:00.000Z',
            csrfToken,
            invitationRevision: 3,
            role: 'builder',
            sessionRotationRequired: true,
            workspace: { id: workspaceId, name: 'Control Operations' },
          },
          { status: 201 },
        ),
      ),
      http.post(
        'http://pertexo.test/v1/invitation-acceptance/complete',
        async ({ request }) => {
          expect(request.headers.get('x-csrf-token')).toBe(
            'csrf-token-for-component-tests-12345678901234567890',
          );
          expect(request.headers.get('x-invitation-csrf-token')).toBe(
            csrfToken,
          );
          requests.push({
            body: await request.json(),
            key: request.headers.get('idempotency-key'),
          });
          completionCount += 1;
          if (completionCount === 1) return HttpResponse.error();
          completed = true;
          return HttpResponse.json({
            intentId,
            workspaceId,
            role: 'builder',
            membershipCreated: true,
            replayed: true,
          });
        },
      ),
      http.get('http://pertexo.test/v1/invitation-acceptance', () =>
        HttpResponse.json(
          completed
            ? {
                state: 'completed',
                intentId,
                expiresAt: '2026-09-19T18:00:00.000Z',
                csrfToken,
                workspace: { id: workspaceId, name: 'Control Operations' },
                role: 'builder',
                membershipCreated: true,
              }
            : { state: 'unavailable' },
        ),
      ),
    );
    const browser = userEvent.setup();
    renderApp(
      `/invitations/accept#token=${encodeURIComponent(`wi1.${workspaceId}.${intentId}.${'a'.repeat(43)}`)}`,
      { strict: true },
    );

    await browser.click(
      await screen.findByRole('button', { name: 'Accept and open workspace' }),
    );
    expect(
      await screen.findByText(/couldn’t confirm whether you joined/u),
    ).toBeVisible();
    await browser.click(
      screen.getByRole('button', { name: 'Accept and open workspace' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Open workspace' }),
    ).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]?.body).toEqual({ intentId, expectedRevision: 3 });
    expect(requests[0]?.key).toBeTruthy();
    await waitFor(() => {
      expect(window.location.hash).toBe('');
    });
  });

  it('offers status reconciliation and same-user sign-in after session loss', async () => {
    let reads = 0;
    mockServer.use(
      http.post('http://pertexo.test/v1/invitation-acceptance/resolve', () =>
        HttpResponse.json(
          {
            state: 'ready',
            intentId,
            expiresAt: '2026-09-19T18:00:00.000Z',
            csrfToken,
            invitationRevision: 3,
            role: 'builder',
            sessionRotationRequired: true,
            workspace: { id: workspaceId, name: 'Control Operations' },
          },
          { status: 201 },
        ),
      ),
      http.post('http://pertexo.test/v1/invitation-acceptance/complete', () =>
        HttpResponse.json(
          {
            type: 'https://pertexo.test/problems/auth.unauthenticated',
            title: 'Authentication required',
            status: 401,
            code: 'auth.unauthenticated',
            requestId: 'request-invitation-session-loss',
          },
          {
            status: 401,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
      ),
      http.get('http://pertexo.test/v1/invitation-acceptance', () => {
        reads += 1;
        return HttpResponse.json({ state: 'unavailable' });
      }),
      http.post('http://pertexo.test/v1/invitation-acceptance/oidc', () =>
        HttpResponse.json({
          authorizationUrl: 'https://issuer.test/authorize',
          expiresAt: '2026-09-19T18:00:00.000Z',
        }),
      ),
    );
    const browser = userEvent.setup();
    renderApp(
      `/invitations/accept#token=${encodeURIComponent(`wi1.${workspaceId}.${intentId}.${'a'.repeat(43)}`)}`,
    );

    await browser.click(
      await screen.findByRole('button', { name: 'Accept and open workspace' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Check status' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeVisible();
    await browser.click(screen.getByRole('button', { name: 'Check status' }));
    await waitFor(() => {
      expect(reads).toBe(1);
    });
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  it('does not redirect when an OIDC start completes after disposal', async () => {
    let finishOidc: ((response: Response) => void) | undefined;
    mockServer.use(
      http.post('http://pertexo.test/v1/invitation-acceptance/resolve', () =>
        HttpResponse.json(
          {
            state: 'sign_in_required',
            intentId,
            expiresAt: '2026-09-19T18:00:00.000Z',
            csrfToken,
          },
          { status: 201 },
        ),
      ),
      http.post(
        'http://pertexo.test/v1/invitation-acceptance/oidc',
        () =>
          new Promise<Response>((resolve) => {
            finishOidc = resolve;
          }),
      ),
    );
    const apiClient = componentApiClient();
    const navigateToProvider = vi.fn();
    const browser = userEvent.setup();
    const rendered = render(
      <InvitationAcceptancePage
        apiClient={apiClient}
        initialToken={`wi1.${workspaceId}.${intentId}.${'a'.repeat(43)}`}
        clearFragment={vi.fn()}
        navigateToProvider={navigateToProvider}
        openWorkspace={vi.fn()}
        openSignIn={vi.fn()}
        openWorkspaceDiscovery={vi.fn()}
      />,
    );
    await browser.click(
      await screen.findByRole('button', { name: 'Sign in to accept' }),
    );
    await waitFor(() => {
      expect(finishOidc).toBeDefined();
    });
    rendered.unmount();
    finishOidc?.(
      HttpResponse.json({
        authorizationUrl: 'https://issuer.test/authorize',
        expiresAt: '2026-09-19T18:00:00.000Z',
      }),
    );
    await Promise.resolve();
    expect(navigateToProvider).not.toHaveBeenCalled();
  });

  it('offers ordinary sign-in and workspace discovery after an unusable continuation reload', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/invitation-acceptance', () =>
        HttpResponse.json({ state: 'unavailable' }),
      ),
    );
    const openSignIn = vi.fn();
    const openWorkspaceDiscovery = vi.fn();
    const browser = userEvent.setup();
    render(
      <InvitationAcceptancePage
        apiClient={componentApiClient()}
        clearFragment={vi.fn()}
        navigateToProvider={vi.fn()}
        openWorkspace={vi.fn()}
        openSignIn={openSignIn}
        openWorkspaceDiscovery={openWorkspaceDiscovery}
      />,
    );

    await browser.click(await screen.findByRole('button', { name: 'Sign in' }));
    await browser.click(
      screen.getByRole('button', { name: 'Go to my workspaces' }),
    );
    expect(openSignIn).toHaveBeenCalledOnce();
    expect(openWorkspaceDiscovery).toHaveBeenCalledOnce();
  });

  it('retries a tokenless continuation read after a transient bootstrap failure', async () => {
    let reads = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/invitation-acceptance', () => {
        reads += 1;
        if (reads === 1) return HttpResponse.error();
        return HttpResponse.json({ state: 'unavailable' });
      }),
    );
    const browser = userEvent.setup();
    render(
      <InvitationAcceptancePage
        apiClient={componentApiClient()}
        clearFragment={vi.fn()}
        navigateToProvider={vi.fn()}
        openWorkspace={vi.fn()}
        openSignIn={vi.fn()}
        openWorkspaceDiscovery={vi.fn()}
      />,
    );

    await browser.click(
      await screen.findByRole('button', {
        name: 'Try again',
      }),
    );
    expect(
      await screen.findByRole('button', { name: 'Sign in' }),
    ).toBeVisible();
    expect(reads).toBe(2);
  });

  it('boots the same invitation link when it is reopened on the mounted route', async () => {
    let resolveRequests = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/invitation-acceptance', () =>
        HttpResponse.json({ state: 'unavailable' }),
      ),
      http.post('http://pertexo.test/v1/invitation-acceptance/resolve', () => {
        resolveRequests += 1;
        return HttpResponse.json(
          {
            state: 'sign_in_required',
            intentId,
            expiresAt: '2026-09-19T18:00:00.000Z',
            csrfToken,
          },
          { status: 201 },
        );
      }),
    );
    const token = `wi1.${workspaceId}.${intentId}.${'a'.repeat(43)}`;
    const { router } = renderApp('/invitations/accept', { strict: true });
    expect(
      await screen.findByRole('button', { name: 'Sign in' }),
    ).toBeVisible();

    await router.navigate({
      to: '/invitations/accept',
      hash: `token=${encodeURIComponent(token)}`,
    });

    expect(
      await screen.findByRole('button', { name: 'Sign in to accept' }),
    ).toBeVisible();
    expect(resolveRequests).toBe(1);
  });

  it('ignores a delayed completion after the mounted route selects another invitation', async () => {
    const tokenA = `wi1.${workspaceId}.${intentId}.${'a'.repeat(43)}`;
    const tokenB = `wi1.${workspaceId}.${otherIntentId}.${'b'.repeat(43)}`;
    let finishCompletion: ((response: Response) => void) | undefined;
    mockServer.use(
      http.post(
        'http://pertexo.test/v1/invitation-acceptance/resolve',
        async ({ request }) => {
          const body = (await request.json()) as { token: string };
          const second = body.token === tokenB;
          return HttpResponse.json(
            {
              state: 'ready',
              intentId: second ? otherIntentId : intentId,
              expiresAt: '2026-09-19T18:00:00.000Z',
              csrfToken: second ? `${csrfToken}-b` : csrfToken,
              invitationRevision: second ? 8 : 3,
              role: second ? 'viewer' : 'builder',
              sessionRotationRequired: true,
              workspace: {
                id: workspaceId,
                name: second ? 'Workspace B' : 'Workspace A',
              },
            },
            { status: 201 },
          );
        },
      ),
      http.post(
        'http://pertexo.test/v1/invitation-acceptance/complete',
        () =>
          new Promise<Response>((resolve) => {
            finishCompletion = resolve;
          }),
      ),
    );
    const browser = userEvent.setup();
    const { router } = renderApp(
      `/invitations/accept#token=${encodeURIComponent(tokenA)}`,
      { strict: true },
    );
    await browser.click(
      await screen.findByRole('button', { name: 'Accept and open workspace' }),
    );
    await waitFor(() => {
      expect(finishCompletion).toBeDefined();
    });

    await router.navigate({
      to: '/invitations/accept',
      hash: `token=${encodeURIComponent(tokenB)}`,
    });
    expect(
      await screen.findByRole('heading', { name: 'Join Workspace B' }),
    ).toBeVisible();
    finishCompletion?.(
      HttpResponse.json({
        intentId,
        workspaceId,
        role: 'builder',
        membershipCreated: true,
        replayed: false,
      }),
    );
    await Promise.resolve();

    expect(
      screen.getByRole('heading', { name: 'Join Workspace B' }),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Accept and open workspace' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Open workspace' }),
    ).not.toBeInTheDocument();
  });

  it('does not let delayed cleanup from the prior journey navigate away from a new invitation', async () => {
    const tokenB = `wi1.${workspaceId}.${otherIntentId}.${'b'.repeat(43)}`;
    let finishCleanup: ((response: Response) => void) | undefined;
    mockServer.use(
      http.get('http://pertexo.test/v1/invitation-acceptance', () =>
        HttpResponse.json({
          state: 'completed',
          intentId,
          expiresAt: '2026-09-19T18:00:00.000Z',
          csrfToken,
          workspace: { id: workspaceId, name: 'Workspace A' },
          role: 'builder',
          membershipCreated: true,
        }),
      ),
      http.delete(
        'http://pertexo.test/v1/invitation-acceptance',
        () =>
          new Promise<Response>((resolve) => {
            finishCleanup = resolve;
          }),
      ),
      http.post('http://pertexo.test/v1/invitation-acceptance/resolve', () =>
        HttpResponse.json(
          {
            state: 'ready',
            intentId: otherIntentId,
            expiresAt: '2026-09-19T18:00:00.000Z',
            csrfToken: `${csrfToken}-b`,
            invitationRevision: 8,
            role: 'viewer',
            sessionRotationRequired: true,
            workspace: { id: workspaceId, name: 'Workspace B' },
          },
          { status: 201 },
        ),
      ),
    );
    const browser = userEvent.setup();
    const { router } = renderApp('/invitations/accept', { strict: true });
    await browser.click(
      await screen.findByRole('button', { name: 'Open workspace' }),
    );
    await waitFor(() => {
      expect(finishCleanup).toBeDefined();
    });

    await router.navigate({
      to: '/invitations/accept',
      hash: `token=${encodeURIComponent(tokenB)}`,
    });
    expect(
      await screen.findByRole('heading', { name: 'Join Workspace B' }),
    ).toBeVisible();
    finishCleanup?.(new Response(null, { status: 204 }));
    await Promise.resolve();

    expect(router.state.location.pathname).toBe('/invitations/accept');
    expect(
      screen.getByRole('heading', { name: 'Join Workspace B' }),
    ).toBeVisible();
  });

  it('retires an uncertain command when reconciliation selects another invitation', async () => {
    const commands: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.post('http://pertexo.test/v1/invitation-acceptance/resolve', () =>
        HttpResponse.json(
          {
            state: 'ready',
            intentId,
            expiresAt: '2026-09-19T18:00:00.000Z',
            csrfToken,
            invitationRevision: 3,
            role: 'builder',
            sessionRotationRequired: true,
            workspace: { id: workspaceId, name: 'Workspace A' },
          },
          { status: 201 },
        ),
      ),
      http.post(
        'http://pertexo.test/v1/invitation-acceptance/complete',
        async ({ request }) => {
          const command = {
            body: await request.json(),
            key: request.headers.get('idempotency-key'),
          };
          commands.push(command);
          if (commands.length === 1) return HttpResponse.error();
          return HttpResponse.json({
            intentId: otherIntentId,
            workspaceId,
            role: 'viewer',
            membershipCreated: true,
            replayed: false,
          });
        },
      ),
      http.get('http://pertexo.test/v1/invitation-acceptance', () =>
        HttpResponse.json({
          state: 'ready',
          intentId: otherIntentId,
          expiresAt: '2026-09-19T18:00:00.000Z',
          csrfToken: `${csrfToken}-other`,
          invitationRevision: 7,
          role: 'viewer',
          sessionRotationRequired: true,
          workspace: { id: workspaceId, name: 'Workspace B' },
        }),
      ),
    );
    const browser = userEvent.setup();
    renderApp(
      `/invitations/accept#token=${encodeURIComponent(`wi1.${workspaceId}.${intentId}.${'a'.repeat(43)}`)}`,
    );
    await browser.click(
      await screen.findByRole('button', { name: 'Accept and open workspace' }),
    );
    await browser.click(
      await screen.findByRole('button', { name: 'Check status' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Join Workspace B' }),
    ).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'different invitation is now selected',
    );
    await browser.click(
      screen.getByRole('button', { name: 'Accept and open workspace' }),
    );
    await screen.findByRole('button', { name: 'Open workspace' });
    expect(commands).toHaveLength(2);
    expect(commands[1]?.body).toEqual({
      intentId: otherIntentId,
      expectedRevision: 7,
    });
    expect(commands[1]?.key).not.toBe(commands[0]?.key);
  });

  it('offers fresh verification when recipient proof expires', async () => {
    const navigateToProvider = vi.fn();
    mockServer.use(
      http.post('http://pertexo.test/v1/invitation-acceptance/resolve', () =>
        HttpResponse.json(
          {
            state: 'ready',
            intentId,
            expiresAt: '2026-09-19T18:00:00.000Z',
            csrfToken,
            invitationRevision: 3,
            role: 'builder',
            sessionRotationRequired: true,
            workspace: { id: workspaceId, name: 'Control Operations' },
          },
          { status: 201 },
        ),
      ),
      http.post('http://pertexo.test/v1/invitation-acceptance/complete', () =>
        HttpResponse.json(
          {
            type: 'https://pertexo.test/problems/workspace.invitation_proof_expired',
            title: 'Invitation verification expired',
            status: 409,
            code: 'workspace.invitation_proof_expired',
            requestId: 'request-proof-expired',
          },
          {
            status: 409,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
      ),
      http.post('http://pertexo.test/v1/invitation-acceptance/oidc', () =>
        HttpResponse.json({
          authorizationUrl: 'https://issuer.test/authorize',
          expiresAt: '2026-09-19T18:00:00.000Z',
        }),
      ),
    );
    const browser = userEvent.setup();
    render(
      <InvitationAcceptancePage
        apiClient={componentApiClient()}
        initialToken={`wi1.${workspaceId}.${intentId}.${'a'.repeat(43)}`}
        clearFragment={vi.fn()}
        navigateToProvider={navigateToProvider}
        openWorkspace={vi.fn()}
        openSignIn={vi.fn()}
        openWorkspaceDiscovery={vi.fn()}
      />,
    );
    await browser.click(
      await screen.findByRole('button', { name: 'Accept and open workspace' }),
    );
    await browser.click(
      await screen.findByRole('button', {
        name: 'Verify invited account again',
      }),
    );
    await waitFor(() => {
      expect(navigateToProvider).toHaveBeenCalledWith(
        'https://issuer.test/authorize',
      );
    });
  });

  it('does not navigate after delayed acceptance cleanup outlives the route', async () => {
    let rejectCleanup: ((reason: Error) => void) | undefined;
    const fetchImplementation = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (init?.method === 'DELETE')
          return new Promise<Response>((_resolve, reject) => {
            rejectCleanup = reject;
          });
        if (requestUrl.endsWith('/v1/invitation-acceptance')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                state: 'completed',
                intentId,
                expiresAt: '2026-09-19T18:00:00.000Z',
                csrfToken,
                workspace: { id: workspaceId, name: 'Control Operations' },
                role: 'viewer',
                membershipCreated: true,
              }),
              { headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return Promise.reject(new Error(`Unexpected request: ${requestUrl}`));
      },
    );
    const openWorkspace = vi.fn();
    const browser = userEvent.setup();
    const rendered = render(
      <InvitationAcceptancePage
        apiClient={componentApiClient(fetchImplementation)}
        clearFragment={vi.fn()}
        navigateToProvider={vi.fn()}
        openWorkspace={openWorkspace}
        openSignIn={vi.fn()}
        openWorkspaceDiscovery={vi.fn()}
      />,
    );
    await browser.click(
      await screen.findByRole('button', { name: 'Open workspace' }),
    );
    rendered.unmount();
    rejectCleanup?.(new Error('cleanup failed'));
    await Promise.resolve();
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it('reports rejected acceptance cleanup without undoing the completed result', async () => {
    const fetchImplementation = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (init?.method === 'DELETE')
          return Promise.reject(new Error('cleanup failed'));
        if (requestUrl.endsWith('/v1/invitation-acceptance'))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                state: 'completed',
                intentId,
                expiresAt: '2026-09-19T18:00:00.000Z',
                csrfToken,
                workspace: { id: workspaceId, name: 'Control Operations' },
                role: 'viewer',
                membershipCreated: true,
              }),
              { headers: { 'content-type': 'application/json' } },
            ),
          );
        return Promise.reject(new Error(`Unexpected request: ${requestUrl}`));
      },
    );
    const openWorkspace = vi.fn();
    const browser = userEvent.setup();
    render(
      <InvitationAcceptancePage
        apiClient={componentApiClient(fetchImplementation)}
        clearFragment={vi.fn()}
        navigateToProvider={vi.fn()}
        openWorkspace={openWorkspace}
        openSignIn={vi.fn()}
        openWorkspaceDiscovery={vi.fn()}
      />,
    );
    await browser.click(
      await screen.findByRole('button', { name: 'Open workspace' }),
    );
    expect(
      await screen.findByText(/couldn’t finish tidying up the invitation/u),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Open workspace' }),
    ).toBeVisible();
    expect(openWorkspace).not.toHaveBeenCalled();
    await browser.click(screen.getByRole('button', { name: 'Open workspace' }));
    expect(openWorkspace).toHaveBeenCalledWith(workspaceId);
    expect(
      fetchImplementation.mock.calls.filter(
        ([, init]) => init?.method === 'DELETE',
      ),
    ).toHaveLength(1);
  });

  it('uses ordinary workspace navigation when another tab replaced the cleanup binding', async () => {
    const fetchImplementation = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (init?.method === 'DELETE')
          return Promise.resolve(
            new Response(
              JSON.stringify({
                type: 'https://pertexo.test/problems/auth.forbidden',
                title: 'Forbidden',
                status: 403,
                code: 'auth.forbidden',
                requestId: 'request-replaced-binding',
              }),
              {
                status: 403,
                headers: { 'content-type': 'application/problem+json' },
              },
            ),
          );
        if (requestUrl.endsWith('/v1/invitation-acceptance'))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                state: 'completed',
                intentId,
                expiresAt: '2026-09-19T18:00:00.000Z',
                csrfToken,
                workspace: { id: workspaceId, name: 'Workspace A' },
                role: 'viewer',
                membershipCreated: true,
              }),
              { headers: { 'content-type': 'application/json' } },
            ),
          );
        return Promise.reject(new Error(`Unexpected request: ${requestUrl}`));
      },
    );
    const openWorkspace = vi.fn();
    const browser = userEvent.setup();
    render(
      <InvitationAcceptancePage
        apiClient={componentApiClient(fetchImplementation)}
        clearFragment={vi.fn()}
        navigateToProvider={vi.fn()}
        openWorkspace={openWorkspace}
        openSignIn={vi.fn()}
        openWorkspaceDiscovery={vi.fn()}
      />,
    );
    await browser.click(
      await screen.findByRole('button', { name: 'Open workspace' }),
    );
    expect(
      await screen.findByText(/couldn’t finish tidying up the invitation/u),
    ).toBeVisible();
    await browser.click(screen.getByRole('button', { name: 'Open workspace' }));
    expect(openWorkspace).toHaveBeenCalledWith(workspaceId);
    expect(
      fetchImplementation.mock.calls.filter(
        ([, init]) => init?.method === 'DELETE',
      ),
    ).toHaveLength(1);
  });

  it('does not navigate when successful cleanup finishes after route disposal', async () => {
    let resolveCleanup: ((response: Response) => void) | undefined;
    const fetchImplementation = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (init?.method === 'DELETE')
          return new Promise<Response>((resolve) => {
            resolveCleanup = resolve;
          });
        if (requestUrl.endsWith('/v1/invitation-acceptance'))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                state: 'completed',
                intentId,
                expiresAt: '2026-09-19T18:00:00.000Z',
                csrfToken,
                workspace: { id: workspaceId, name: 'Workspace A' },
                role: 'viewer',
                membershipCreated: true,
              }),
              { headers: { 'content-type': 'application/json' } },
            ),
          );
        return Promise.reject(new Error(`Unexpected request: ${requestUrl}`));
      },
    );
    const openWorkspace = vi.fn();
    const browser = userEvent.setup();
    const rendered = render(
      <InvitationAcceptancePage
        apiClient={componentApiClient(fetchImplementation)}
        clearFragment={vi.fn()}
        navigateToProvider={vi.fn()}
        openWorkspace={openWorkspace}
        openSignIn={vi.fn()}
        openWorkspaceDiscovery={vi.fn()}
      />,
    );
    await browser.click(
      await screen.findByRole('button', { name: 'Open workspace' }),
    );
    rendered.unmount();
    resolveCleanup?.(new Response(null, { status: 204 }));
    await Promise.resolve();
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', 'This invitation has expired'],
    ['revoked', 'This invitation was withdrawn'],
    ['superseded', 'A newer invitation replaced this one'],
  ] as const)(
    'explains a %s invitation in words and points to workspaces',
    async (state, title) => {
      mockServer.use(
        http.get('http://pertexo.test/v1/invitation-acceptance', () =>
          HttpResponse.json({
            state,
            intentId,
            expiresAt: '2026-09-19T18:00:00.000Z',
            csrfToken,
          }),
        ),
      );
      const openWorkspaceDiscovery = vi.fn();
      render(
        <InvitationAcceptancePage
          apiClient={componentApiClient()}
          clearFragment={vi.fn()}
          navigateToProvider={vi.fn()}
          openWorkspace={vi.fn()}
          openSignIn={vi.fn()}
          openWorkspaceDiscovery={openWorkspaceDiscovery}
        />,
      );
      expect(await screen.findByRole('heading', { name: title })).toBeVisible();
      expect(
        screen.getByText(/Ask an admin for a new invitation/u),
      ).toBeVisible();
      expect(document.body).not.toHaveTextContent(
        state === 'superseded' ? /superseded/u : /is revoked|is expired\./u,
      );
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Go to my workspaces' }));
      expect(openWorkspaceDiscovery).toHaveBeenCalledOnce();
    },
  );

  it('names the signed-in account when the invitation belongs to another', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/invitation-acceptance', () =>
        HttpResponse.json({
          state: 'wrong_account',
          intentId,
          expiresAt: '2026-09-19T18:00:00.000Z',
          csrfToken,
        }),
      ),
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json({
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          email: 'someone-else@example.test',
          displayName: 'Someone Else',
          status: 'active',
          revision: 1,
          createdAt: '2026-09-14T10:00:00.000Z',
          updatedAt: '2026-09-14T10:00:00.000Z',
        }),
      ),
    );
    renderApp('/invitations/accept');
    expect(
      await screen.findByRole('heading', {
        name: 'This invitation is for someone else',
      }),
    ).toBeVisible();
    expect(await screen.findByText('someone-else@example.test')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Switch account' }),
    ).toBeVisible();
  });

  it('sets a ready invitation aside with Not now before leaving', async () => {
    let cleared = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/invitation-acceptance', () =>
        HttpResponse.json({
          state: 'ready',
          intentId,
          expiresAt: '2026-09-19T18:00:00.000Z',
          csrfToken,
          invitationRevision: 3,
          role: 'builder',
          sessionRotationRequired: true,
          workspace: { id: workspaceId, name: 'Control Operations' },
        }),
      ),
      http.delete(
        'http://pertexo.test/v1/invitation-acceptance',
        ({ request }) => {
          expect(request.headers.get('x-invitation-csrf-token')).toBe(
            csrfToken,
          );
          cleared += 1;
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    const openWorkspaceDiscovery = vi.fn();
    render(
      <InvitationAcceptancePage
        apiClient={componentApiClient()}
        clearFragment={vi.fn()}
        navigateToProvider={vi.fn()}
        openWorkspace={vi.fn()}
        openSignIn={vi.fn()}
        openWorkspaceDiscovery={openWorkspaceDiscovery}
      />,
    );
    expect(
      await screen.findByRole('heading', { name: 'Join Control Operations' }),
    ).toBeVisible();
    expect(
      screen.getByText('Builds, publishes and runs workflows'),
    ).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => {
      expect(openWorkspaceDiscovery).toHaveBeenCalledOnce();
    });
    expect(cleared).toBe(1);
  });

  it('opens a joined workspace on its own after a visible pause, unless asked to stay', async () => {
    const completed = {
      state: 'completed',
      intentId,
      expiresAt: '2026-09-19T18:00:00.000Z',
      csrfToken,
      workspace: { id: workspaceId, name: 'Control Operations' },
      role: 'viewer',
      membershipCreated: true,
    };
    mockServer.use(
      http.get('http://pertexo.test/v1/invitation-acceptance', () =>
        HttpResponse.json(completed),
      ),
      http.delete(
        'http://pertexo.test/v1/invitation-acceptance',
        () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const openWorkspace = vi.fn();
    const automatic = render(
      <InvitationAcceptancePage
        apiClient={componentApiClient()}
        clearFragment={vi.fn()}
        navigateToProvider={vi.fn()}
        openWorkspace={openWorkspace}
        openSignIn={vi.fn()}
        openWorkspaceDiscovery={vi.fn()}
        autoOpenAfterMs={60}
      />,
    );
    expect(
      await screen.findByText('Opening Control Operations…'),
    ).toBeVisible();
    await waitFor(() => {
      expect(openWorkspace).toHaveBeenCalledWith(workspaceId);
    });
    automatic.unmount();

    const stayed = vi.fn();
    render(
      <InvitationAcceptancePage
        apiClient={componentApiClient()}
        clearFragment={vi.fn()}
        navigateToProvider={vi.fn()}
        openWorkspace={stayed}
        openSignIn={vi.fn()}
        openWorkspaceDiscovery={vi.fn()}
        autoOpenAfterMs={200}
      />,
    );
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Stay here' }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stayed).not.toHaveBeenCalled();
    expect(screen.queryByText('Opening Control Operations…')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Open workspace' }),
    ).toBeVisible();
  });
});
