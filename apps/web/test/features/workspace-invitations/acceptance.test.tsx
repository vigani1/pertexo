import { InvitationAcceptancePage } from '@/features/workspace-invitations/pages/invitation-acceptance';
import { installAcceptanceHandlers } from './acceptance/setup';

import { act, render, screen, waitFor } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { Activity } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockServer } from '../../support/mock-server';

import { renderApp } from '../../support/render-app';

import {
  componentApiClient,
  csrfToken,
  intentId,
  workspaceId,
} from './acceptance/fixture';

afterEach(() => vi.useRealTimers());

describe('invitation acceptance', () => {
  beforeEach(installAcceptanceHandlers);
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
  it('cancels a hidden invitation read and resumes the same link when shown', async () => {
    const token = `wi1.${workspaceId}.${intentId}.${'a'.repeat(43)}`;
    const calls: { signal: AbortSignal | null | undefined; body: unknown }[] =
      [];
    let releaseFirst: ((response: Response) => void) | undefined;
    const apiClient = componentApiClient((_input, init) => {
      if (typeof init?.body !== 'string')
        throw new Error('Expected an invitation body');
      calls.push({ signal: init.signal, body: JSON.parse(init.body) });
      if (calls.length === 1)
        return new Promise<Response>((resolve) => {
          releaseFirst = resolve;
        });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            state: 'ready',
            intentId,
            expiresAt: '2026-09-19T18:00:00.000Z',
            csrfToken,
            invitationRevision: 3,
            role: 'builder',
            sessionRotationRequired: true,
            workspace: { id: workspaceId, name: 'Control Operations' },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    const props = {
      apiClient,
      initialToken: token,
      clearFragment: vi.fn(),
      navigation: {
        openWorkspace: vi.fn(),
        openSignIn: vi.fn(),
        openWorkspaceDiscovery: vi.fn(),
      },
    };
    const view = render(
      <Activity mode="visible">
        <InvitationAcceptancePage {...props} />
      </Activity>,
    );
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    view.rerender(
      <Activity mode="hidden">
        <InvitationAcceptancePage {...props} />
      </Activity>,
    );
    expect(calls[0]?.signal?.aborted).toBe(true);
    view.rerender(
      <Activity mode="visible">
        <InvitationAcceptancePage {...props} />
      </Activity>,
    );
    expect(
      await screen.findByRole('button', { name: 'Accept and open workspace' }),
    ).toBeVisible();
    expect(calls.map((call) => call.body)).toEqual([{ token }, { token }]);
    await act(async () => {
      releaseFirst?.(
        new Response(JSON.stringify({ state: 'unavailable' }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
      await Promise.resolve();
    });
    expect(
      screen.getByRole('button', { name: 'Accept and open workspace' }),
    ).toBeVisible();
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
});
