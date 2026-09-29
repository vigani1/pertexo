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
  fixtureWorkspace,
  identityHandlers,
  notFoundProblem,
  statisticsHandler,
} from '../support/run-fixtures';
import {
  draftBody,
  editorHandlers,
  emptyGraph,
  etagA,
  user as editorUser,
} from '../support/workflow-editor-fixtures';

const {
  workspace: workspaceId,
  firstRun: runId,
  workflow: workflowId,
} = fixtureIds;
const readerCapabilities = ['workspace:read', 'run:read', 'workflow:read'];
const editorWorkspaceId = '01a0e3bb-aac9-75b8-845e-fa98f0e3e6c5';
const editorWorkflowId = '01a0e3bb-dca6-725a-9467-b223a018bc1a';
const editorApi = `http://pertexo.test/v1/workspaces/${editorWorkspaceId}/workflows/${editorWorkflowId}`;
const editorRoute = `/w/${editorWorkspaceId}/workflows/${editorWorkflowId}`;

function installExistingEditorHandlers(
  draftRead: () => Response | Promise<Response> = () =>
    HttpResponse.json(
      { ...draftBody(emptyGraph, 1), workflowId: editorWorkflowId },
      { headers: { etag: etagA } },
    ),
  connectionsRead: () => Response | Promise<Response> = () =>
    HttpResponse.json({ items: [], nextCursor: null }),
) {
  mockServer.use(...editorHandlers(() => undefined));
  mockServer.use(
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({
        items: [
          {
            ...fixtureWorkspace([
              'workspace:read',
              'workflow:read',
              'workflow:update',
              'connection:read',
            ]),
            id: editorWorkspaceId,
          },
        ],
        nextCursor: null,
      }),
    ),
    http.get(
      `http://pertexo.test/v1/workspaces/${editorWorkspaceId}/connections`,
      connectionsRead,
    ),
    http.get(editorApi, () =>
      HttpResponse.json({
        workflow: {
          id: editorWorkflowId,
          workspaceId: editorWorkspaceId,
          name: 'Owned editor smoke',
          nameRevision: 1,
          lifecycleStatus: 'active',
          lifecycleRevision: 1,
          activationStatus: 'inactive',
          publishedVersionId: null,
          createdAt: '2026-09-27T16:38:54.900Z',
          updatedAt: '2026-09-27T16:38:54.882Z',
        },
      }),
    ),
    http.get(`${editorApi}/draft`, draftRead),
  );
}

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

  it('keeps the shell around an address that leads nowhere', async () => {
    mockServer.use(...identityHandlers(readerCapabilities));
    renderApp(`/w/${workspaceId}/nowhere/at-all`);
    expect(
      await screen.findByRole(
        'heading',
        { name: 'This page doesn’t exist' },
        coldStart,
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Go home' })).toHaveAttribute(
      'href',
      `/w/${workspaceId}`,
    );
    expect(
      screen.getByRole('navigation', { name: 'Breadcrumb' }),
    ).toBeVisible();
  });

  it('shows a missing workflow inside the shell, not the hub', async () => {
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      http.get(`${apiBase}/workflows/${workflowId}`, notFoundProblem),
      http.get(`${apiBase}/workflows/${workflowId}/draft`, notFoundProblem),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}`);
    expect(
      await screen.findByRole(
        'heading',
        { name: 'This workflow doesn’t exist' },
        coldStart,
      ),
    ).toBeVisible();
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(
      within(trail).getByRole('link', { name: 'Workflows' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/workflows`);
  });

  it('opens an existing workflow’s editor when connection discovery is unavailable', async () => {
    // A local API without connection encryption answers 404 for connections.
    installExistingEditorHandlers(undefined, notFoundProblem);
    const { router } = renderApp(editorRoute);
    await waitFor(() => {
      expect(
        router.state.matches.find(
          (match) => match.routeId === '/w/$workspaceId/workflows/$workflowId/',
        )?.loaderData,
      ).toEqual({ found: true });
    });
    expect(
      await screen.findByRole('application', {}, coldStart),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'This workflow doesn’t exist' }),
    ).toBeNull();
    expect(
      screen.queryByRole('heading', { name: 'This doesn’t exist' }),
    ).toBeNull();
  });

  it('observes an early supporting failure while the draft read is delayed', async () => {
    let releaseDraft: ((response: Response) => void) | undefined;
    const delayedDraft = new Promise<Response>((resolve) => {
      releaseDraft = resolve;
    });
    let supportingRead = false;
    installExistingEditorHandlers(
      () => delayedDraft,
      () => {
        supportingRead = true;
        return HttpResponse.json(
          {
            type: 'urn:pertexo:problem:internal.unavailable',
            title: 'Service unavailable',
            status: 500,
            code: 'internal.unavailable',
            requestId: 'request-support-unavailable',
          },
          {
            status: 500,
            headers: { 'content-type': 'application/problem+json' },
          },
        );
      },
    );
    renderApp(editorRoute);
    await waitFor(() => {
      expect(supportingRead).toBe(true);
    });
    releaseDraft?.(
      HttpResponse.json(
        { ...draftBody(emptyGraph, 1), workflowId: editorWorkflowId },
        { headers: { etag: etagA } },
      ),
    );
    expect(
      await screen.findByRole('heading', {
        name: 'Something broke on our side',
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'This workflow doesn’t exist' }),
    ).toBeNull();
  });

  it('signs out for an unavailable supporting read that reports 401', async () => {
    mockServer.use(signInCapabilities);
    installExistingEditorHandlers(undefined, unauthenticated);
    let sessionChecks = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () => {
        sessionChecks += 1;
        return sessionChecks === 1
          ? HttpResponse.json(editorUser)
          : unauthenticated();
      }),
    );
    const { router } = renderApp(editorRoute);
    expect(
      await screen.findByRole('heading', { name: 'Sign in to continue' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('still treats a missing draft as a missing workflow', async () => {
    installExistingEditorHandlers(notFoundProblem);
    renderApp(editorRoute);
    expect(
      await screen.findByRole('heading', {
        name: 'This workflow doesn’t exist',
      }),
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

  it('draws a progress thread while a page change waits on the session check', async () => {
    let checks = 0;
    let release: () => void = () => undefined;
    mockServer.use(
      ...identityHandlers(readerCapabilities).slice(1),
      http.get('http://pertexo.test/v1/users/me', async () => {
        checks += 1;
        if (checks > 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return HttpResponse.json(fixtureUser);
      }),
      noWorkflows,
      statisticsHandler(),
      http.get(`${apiBase}/runs`, pending),
    );
    const { router } = renderApp(`/w/${workspaceId}/runs`);
    await screen.findByRole('heading', { level: 1, name: 'Runs' }, coldStart);
    expect(screen.queryByRole('progressbar')).toBeNull();

    void router.navigate({
      to: '/w/$workspaceId/workflows',
      params: { workspaceId },
    });
    expect(
      await screen.findByRole('progressbar', { name: 'Loading the page' }),
    ).toBeInTheDocument();
    // The page stays as it was until the check answers.
    expect(
      screen.getByRole('heading', { level: 1, name: 'Runs' }),
    ).toBeVisible();

    release();
    expect(
      await screen.findByRole(
        'heading',
        { level: 1, name: 'Workflows' },
        coldStart,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('progressbar')).toBeNull();
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
