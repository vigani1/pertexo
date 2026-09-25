import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  apiBase,
  coldStart,
  fixtureIds,
  fixtureUser,
  identityHandlers,
  notFoundProblem,
  statisticsHandler,
} from '../support/run-fixtures';

const { workspace: workspaceId, firstRun: runId } = fixtureIds;
const readerCapabilities = ['workspace:read', 'run:read', 'workflow:read'];

function unauthenticated() {
  return HttpResponse.json(
    {
      type: 'urn:pertexo:problem:auth.unauthenticated',
      title: 'Authentication required',
      status: 401,
      code: 'auth.unauthenticated',
      requestId: 'request-signed-out',
    },
    { status: 401, headers: { 'content-type': 'application/problem+json' } },
  );
}

const signInCapabilities = http.get(
  'http://pertexo.test/v1/auth/capabilities',
  () =>
    HttpResponse.json({
      password: {
        enabled: true,
        minimumLength: 12,
        verificationRequired: true,
      },
      socialProviders: [],
    }),
);

const noWorkflows = http.get(`${apiBase}/workflows`, () =>
  HttpResponse.json({ items: [], nextCursor: null }),
);

/** A read that never answers, so a page can only render around it. */
function pending() {
  return new Promise<Response>(() => undefined);
}

afterEach(() => {
  localStorage.clear();
});

describe('route loading', () => {
  it('renders a page while its warmed reads are still in flight', async () => {
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      noWorkflows,
      statisticsHandler(),
      http.get(`${apiBase}/runs`, pending),
    );
    renderApp(`/w/${workspaceId}/runs`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Runs' }, coldStart),
    ).toBeVisible();
    expect(
      screen.getByRole('navigation', { name: 'Breadcrumb' }),
    ).toBeVisible();
  });

  it('still signs out when the session check in beforeLoad fails', async () => {
    mockServer.use(
      signInCapabilities,
      http.get('http://pertexo.test/v1/users/me', unauthenticated),
    );
    const { router } = renderApp(`/w/${workspaceId}/runs`);
    expect(
      await screen.findByRole(
        'heading',
        { name: 'Sign in to continue' },
        coldStart,
      ),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('signs out when a warmed read finds the session gone', async () => {
    let sessionChecks = 0;
    mockServer.use(
      signInCapabilities,
      http.get('http://pertexo.test/v1/users/me', () => {
        sessionChecks += 1;
        return sessionChecks === 1
          ? HttpResponse.json(fixtureUser)
          : unauthenticated();
      }),
      ...identityHandlers(readerCapabilities).slice(1),
      noWorkflows,
      statisticsHandler(),
      http.get(`${apiBase}/runs`, unauthenticated),
    );
    const { router } = renderApp(`/w/${workspaceId}/runs`);
    expect(
      await screen.findByRole(
        'heading',
        { name: 'Sign in to continue' },
        coldStart,
      ),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('keeps a missing run inside the shell', async () => {
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      http.get(`${apiBase}/runs/${runId}`, notFoundProblem),
    );
    renderApp(`/w/${workspaceId}/runs/${runId}`);
    expect(
      await screen.findByRole(
        'heading',
        { name: 'This run doesn’t exist' },
        coldStart,
      ),
    ).toBeVisible();
    expect(
      screen.getByRole('navigation', { name: 'Breadcrumb' }),
    ).toBeVisible();
  });

  it('keeps a workspace the person cannot open out of the shell', async () => {
    mockServer.use(...identityHandlers(readerCapabilities));
    renderApp('/w/12345678-1234-4234-8234-123456789012/runs');
    expect(
      await screen.findByRole(
        'heading',
        { name: 'This workspace isn’t available' },
        coldStart,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
  });

  it('names a known workspace while it opens and admits a slow connection', async () => {
    localStorage.setItem(
      'pertexo:last-workspace:v1',
      JSON.stringify({
        userId: fixtureIds.user,
        workspaceId,
        workspaceName: 'Control Operations',
      }),
    );
    mockServer.use(http.get('http://pertexo.test/v1/users/me', pending));
    renderApp(`/w/${workspaceId}`);
    const boot = await screen.findByRole('status', {}, coldStart);
    expect(within(boot).getByText('Opening Control Operations…')).toBeVisible();
    await waitFor(
      () => {
        expect(within(boot).getByText('Still connecting…')).toBeVisible();
      },
      { timeout: 3_500 },
    );
  });
});
