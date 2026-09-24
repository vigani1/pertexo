import { HttpResponse, http } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const release = {
  epoch: 1,
  fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
};
const user = {
  id: userId,
  email: 'owner@example.test',
  displayName: 'Workspace Owner',
  status: 'active',
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};
const workspace = {
  id: workspaceId,
  name: 'Control Operations',
  slug: 'control-operations',
  status: 'active',
  revision: 1,
  role: 'owner',
  capabilities: [
    'workspace:read',
    'workflow:read',
    'workflow:create',
    'connection:read',
  ],
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};

function summary(id: string, name: string) {
  return {
    id,
    workspaceId,
    name,
    lifecycleStatus: 'active',
    lifecycleRevision: 1,
    activationStatus: 'inactive',
    publishedVersionId: null,
    createdAt: '2026-09-14T10:00:00.000Z',
    updatedAt: '2026-09-14T10:00:00.000Z',
  };
}

function discoveryHandlers() {
  return [
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items: [workspace], nextCursor: null }),
    ),
    http.get('http://pertexo.test/v1/node-definitions', () =>
      HttpResponse.json({ schemaVersion: 1, release, items: [] }),
    ),
    http.get('http://pertexo.test/v1/integrations', () =>
      HttpResponse.json({ schemaVersion: 1, release, items: [] }),
    ),
    http.get(
      `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
      () => HttpResponse.json({ items: [], nextCursor: null }),
    ),
  ];
}

describe('workflow list and create', () => {
  it('returns to login when the session expires during scoped discovery', async () => {
    let userReads = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () => {
        userReads += 1;
        if (userReads === 1) return HttpResponse.json(user);
        return HttpResponse.json(
          {
            type: 'urn:pertexo:problem:auth.unauthenticated',
            title: 'Authentication required',
            status: 401,
            code: 'auth.unauthenticated',
            requestId: 'request-session-expired',
          },
          {
            status: 401,
            headers: { 'content-type': 'application/problem+json' },
          },
        );
      }),
      ...discoveryHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
        () =>
          HttpResponse.json(
            {
              type: 'urn:pertexo:problem:auth.unauthenticated',
              title: 'Authentication required',
              status: 401,
              code: 'auth.unauthenticated',
              requestId: 'request-session-expired',
            },
            {
              status: 401,
              headers: { 'content-type': 'application/problem+json' },
            },
          ),
      ),
    );
    renderApp(`/w/${workspaceId}/workflows`);
    expect(
      await screen.findByRole('heading', { name: 'Sign in to continue' }),
    ).toBeVisible();
  });

  it('loads real pages and appends the next cursor page', async () => {
    mockServer.use(
      ...discoveryHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
        ({ request }) => {
          const after = new URL(request.url).searchParams.get('after');
          return HttpResponse.json(
            after === null
              ? {
                  items: [summary(workflowId, 'Daily intake')],
                  nextCursor: 'page-two',
                }
              : {
                  items: [
                    summary(
                      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                      'Incident response',
                    ),
                  ],
                  nextCursor: null,
                },
          );
        },
      ),
    );

    renderApp(`/w/${workspaceId}/workflows`);
    expect(await screen.findByText('Daily intake')).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Incident response')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Load more' }),
    ).not.toBeInTheDocument();
  });

  it('keeps the first page and retries only the failed next page', async () => {
    let nextPageAttempts = 0;
    mockServer.use(
      ...discoveryHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
        ({ request }) => {
          const after = new URL(request.url).searchParams.get('after');
          if (after === null)
            return HttpResponse.json({
              items: [summary(workflowId, 'Daily intake')],
              nextCursor: 'page-two',
            });
          nextPageAttempts += 1;
          if (nextPageAttempts === 1) return HttpResponse.error();
          return HttpResponse.json({
            items: [
              summary(
                'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                'Incident response',
              ),
            ],
            nextCursor: null,
          });
        },
      ),
    );

    renderApp(`/w/${workspaceId}/workflows`);
    const event = userEvent.setup();
    expect(await screen.findByText('Daily intake')).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The next workflow page could not be loaded',
    );
    expect(screen.getByText('Daily intake')).toBeVisible();
    expect(
      screen.queryByText(/Showing the last loaded workflows/u),
    ).not.toBeInTheDocument();

    await event.click(screen.getByRole('button', { name: 'Retry next page' }));
    expect(await screen.findByText('Incident response')).toBeVisible();
    expect(nextPageAttempts).toBe(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('labels lifecycle and activation independently without the desktop header', async () => {
    mockServer.use(
      ...discoveryHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
        () =>
          HttpResponse.json({
            items: [
              {
                ...summary(workflowId, 'Always-on intake'),
                activationStatus: 'active',
              },
            ],
            nextCursor: null,
          }),
      ),
    );

    renderApp(`/w/${workspaceId}/workflows`);
    expect(await screen.findByText('Always-on intake')).toBeVisible();
    expect(screen.getAllByText('Lifecycle')).toHaveLength(2);
    expect(screen.getAllByText('Activation')).toHaveLength(2);
    expect(screen.getByLabelText('Lifecycle: active')).toBeVisible();
    expect(screen.getByLabelText('Activation: active')).toBeVisible();
    expect(screen.getAllByText('active')).toHaveLength(2);
  });

  it('validates the name and reuses one idempotency key for an uncertain retry', async () => {
    const keys: string[] = [];
    let created = false;
    mockServer.use(
      ...discoveryHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
        () =>
          HttpResponse.json({
            items: created ? [summary(workflowId, 'Nightly sync')] : [],
            nextCursor: null,
          }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
        async ({ request }) => {
          keys.push(request.headers.get('idempotency-key') ?? '');
          expect(request.headers.get('x-csrf-token')).toBe(
            'csrf-token-for-component-tests-12345678901234567890',
          );
          const body = await request.json();
          expect(body).toEqual({ name: 'Nightly sync' });
          if (keys.length === 1) return HttpResponse.error();
          created = true;
          return HttpResponse.json(
            {
              workflow: summary(workflowId, 'Nightly sync'),
              draft: {
                workflowId,
                revision: 1,
                schemaVersion: 1,
                graph: { schemaVersion: 1, nodes: [], edges: [], settings: {} },
                compatibility: {
                  compatible: true,
                  fingerprint: `wf-compat:v1:sha256:${'a'.repeat(64)}`,
                  issues: [],
                },
                updatedAt: '2026-09-14T10:00:00.000Z',
              },
            },
            { status: 201, headers: { etag: `"draft-v1.${'a'.repeat(43)}"` } },
          );
        },
      ),
    );

    renderApp(`/w/${workspaceId}/workflows`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Create workflow' }),
    );
    await event.click(screen.getByRole('button', { name: 'Create workflow' }));
    expect(
      await screen.findByText(
        'Enter a workflow name between 1 and 128 characters.',
      ),
    ).toBeVisible();
    await event.type(
      screen.getByLabelText('Workflow name'),
      '  Nightly sync  ',
    );
    await event.click(screen.getByRole('button', { name: 'Create workflow' }));
    expect(
      await screen.findByRole('button', { name: 'Retry safely' }),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Retry safely' }));
    expect(await screen.findByText('Nightly sync')).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('freezes the submitted create intent while its request is pending', async () => {
    let releaseCreate: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let createCalls = 0;
    mockServer.use(
      ...discoveryHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
        () => HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
        async () => {
          createCalls += 1;
          await blocked;
          return HttpResponse.json(
            {
              workflow: summary(workflowId, 'Pending workflow'),
              draft: {
                workflowId,
                revision: 1,
                schemaVersion: 1,
                graph: { schemaVersion: 1, nodes: [], edges: [], settings: {} },
                compatibility: {
                  compatible: true,
                  fingerprint: `wf-compat:v1:sha256:${'a'.repeat(64)}`,
                  issues: [],
                },
                updatedAt: '2026-09-14T10:00:00.000Z',
              },
            },
            { status: 201, headers: { etag: `"draft-v1.${'a'.repeat(43)}"` } },
          );
        },
      ),
    );
    renderApp(`/w/${workspaceId}/workflows`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Create workflow' }),
    );
    const name = screen.getByLabelText('Workflow name');
    await event.type(name, 'Pending workflow');
    await event.click(screen.getByRole('button', { name: 'Create workflow' }));
    expect(name).toBeDisabled();
    await event.type(name, ' changed');
    expect(name).toHaveValue('Pending workflow');
    expect(createCalls).toBe(1);
    releaseCreate?.();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(createCalls).toBe(1);
  });

  it('keeps the empty state read-only without create capability', async () => {
    mockServer.use(
      ...discoveryHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
        () => HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    const readOnlyWorkspace = {
      ...workspace,
      role: 'viewer',
      capabilities: ['workspace:read', 'workflow:read'],
    };
    mockServer.use(
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [readOnlyWorkspace], nextCursor: null }),
      ),
    );
    renderApp(`/w/${workspaceId}/workflows`);
    expect(
      await screen.findByRole('heading', { name: 'No workflows yet' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /create/i }),
    ).not.toBeInTheDocument();
  });
});
