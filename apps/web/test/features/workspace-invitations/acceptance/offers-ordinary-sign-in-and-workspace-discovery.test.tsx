import { InvitationAcceptancePage } from '@/features/workspace-invitations/pages/invitation-acceptance';
import { installAcceptanceHandlers } from './setup';

import { render, screen, waitFor } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

import {
  componentApiClient,
  csrfToken,
  intentId,
  otherIntentId,
  workspaceId,
} from './fixture';

afterEach(() => vi.useRealTimers());

describe('invitation acceptance', () => {
  beforeEach(installAcceptanceHandlers);
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
        navigation={{
          openWorkspace: vi.fn(),
          openSignIn,
          openWorkspaceDiscovery,
        }}
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
        navigation={{
          openWorkspace: vi.fn(),
          openSignIn: vi.fn(),
          openWorkspaceDiscovery: vi.fn(),
        }}
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
    expect(resolveRequests).toBeGreaterThanOrEqual(1);
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
});
