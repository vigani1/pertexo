import { InvitationAcceptancePage } from '@/features/workspace-invitations/pages/invitation-acceptance';
import { installAcceptanceHandlers } from './setup';

import { act, render, screen, waitFor } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createUserFixture } from '../../../support/fixtures/identity';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

import { getRequestUrl } from '../../../support/request';

import {
  componentApiClient,
  csrfToken,
  intentId,
  workspaceId,
} from './fixture';

afterEach(() => vi.useRealTimers());

describe('invitation acceptance', () => {
  beforeEach(installAcceptanceHandlers);
  it('uses ordinary workspace navigation when another tab replaced the cleanup binding', async () => {
    const fetchImplementation = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl = getRequestUrl(input);
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
        navigation={{
          openWorkspace,
          openSignIn: vi.fn(),
          openWorkspaceDiscovery: vi.fn(),
        }}
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
        const requestUrl = getRequestUrl(input);
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
        navigation={{
          openWorkspace,
          openSignIn: vi.fn(),
          openWorkspaceDiscovery: vi.fn(),
        }}
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
          navigation={{
            openWorkspace: vi.fn(),
            openSignIn: vi.fn(),
            openWorkspaceDiscovery,
          }}
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
        HttpResponse.json(
          createUserFixture({
            email: 'someone-else@example.test',
            displayName: 'Someone Else',
            createdAt: '2026-09-14T10:00:00.000Z',
            updatedAt: '2026-09-14T10:00:00.000Z',
          }),
        ),
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
        navigation={{
          openWorkspace: vi.fn(),
          openSignIn: vi.fn(),
          openWorkspaceDiscovery,
        }}
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
        autoOpenAfterMs={60}
        navigation={{
          openWorkspace,
          openSignIn: vi.fn(),
          openWorkspaceDiscovery: vi.fn(),
        }}
      />,
    );
    expect(
      await screen.findByText('Opening Control Operations…'),
    ).toBeVisible();
    await waitFor(() => {
      expect(openWorkspace).toHaveBeenCalledWith(workspaceId);
    });
    automatic.unmount();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const stayed = vi.fn();
    render(
      <InvitationAcceptancePage
        apiClient={componentApiClient()}
        clearFragment={vi.fn()}
        autoOpenAfterMs={200}
        navigation={{
          openWorkspace: stayed,
          openSignIn: vi.fn(),
          openWorkspaceDiscovery: vi.fn(),
        }}
      />,
    );
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(await screen.findByRole('button', { name: 'Stay here' }));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(stayed).not.toHaveBeenCalled();
    expect(screen.queryByText('Opening Control Operations…')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Open workspace' }),
    ).toBeVisible();
  });
});
