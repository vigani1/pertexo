import { InvitationAcceptancePage } from '@/features/workspace-invitations/pages/invitation-acceptance';
import { installAcceptanceHandlers } from './setup';

import { render, screen, waitFor } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

import { getRequestUrl } from '../../../support/request';

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
    const openFreshSignIn = vi.fn();
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
      http.post('http://pertexo.test/v1/invitation-acceptance/session', () =>
        HttpResponse.json(
          {
            type: 'https://pertexo.test/problems/workspace.invitation_proof_expired',
            title: 'Invitation verification expired',
            status: 409,
            code: 'workspace.invitation_proof_expired',
            requestId: 'request-proof-expired-again',
          },
          {
            status: 409,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
      ),
    );
    const browser = userEvent.setup();
    render(
      <InvitationAcceptancePage
        apiClient={componentApiClient()}
        initialToken={`wi1.${workspaceId}.${intentId}.${'a'.repeat(43)}`}
        clearFragment={vi.fn()}
        navigation={{
          openWorkspace: vi.fn(),
          openSignIn: vi.fn(),
          openFreshSignIn,
          openWorkspaceDiscovery: vi.fn(),
        }}
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
      expect(openFreshSignIn).toHaveBeenCalledOnce();
    });
  });
  it('does not navigate after delayed acceptance cleanup outlives the route', async () => {
    let rejectCleanup: ((reason: Error) => void) | undefined;
    const fetchImplementation = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl = getRequestUrl(input);
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
    rejectCleanup?.(new Error('cleanup failed'));
    await Promise.resolve();
    expect(openWorkspace).not.toHaveBeenCalled();
  });
  it('reports rejected acceptance cleanup without undoing the completed result', async () => {
    const fetchImplementation = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl = getRequestUrl(input);
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
});
