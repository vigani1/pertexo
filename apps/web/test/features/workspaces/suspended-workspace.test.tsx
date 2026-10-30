import { screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { createWorkspaceFixture } from '../../support/fixtures/identity';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
import { user, workspaceId } from './general/fixture';

const everything = [
  'workspace:read',
  'workspace:manage',
  'workflow:read',
  'workflow:create',
  'workflow:update',
  'workflow:publish',
  'run:read',
  'run:start',
  'connection:read',
  'connection:use',
  'connection:manage',
  'member:read',
  'member:manage',
] as const;

const API = `http://pertexo.test/v1/workspaces/${workspaceId}`;
const timestamp = '2026-10-30T10:00:00.000Z';

function suspendedOwner() {
  const requests: string[] = [];
  mockServer.events.on('request:start', ({ request }) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
  });
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({
        items: [
          createWorkspaceFixture({
            id: workspaceId,
            status: 'suspended',
            role: 'owner',
            capabilities: [...everything],
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        ],
        nextCursor: null,
      }),
    ),
  );
  return requests;
}

describe('a suspended workspace', () => {
  it('still shows the owner what they hold, with only the reactivate and delete actions', async () => {
    suspendedOwner();
    renderApp(`/w/${workspaceId}/settings`);

    expect(
      await screen.findByRole('button', { name: 'Reactivate workspace' }),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Delete workspace' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Leave workspace' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Reactivate' })).toBeVisible();
  });

  it('tells someone who cannot lift the suspension who can', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({
          items: [
            createWorkspaceFixture({
              id: workspaceId,
              status: 'suspended',
              role: 'viewer',
              capabilities: ['workspace:read', 'workflow:read', 'run:read'],
              createdAt: timestamp,
              updatedAt: timestamp,
            }),
          ],
          nextCursor: null,
        }),
      ),
    );
    renderApp(`/w/${workspaceId}/settings`);

    expect(
      await screen.findByText(/An owner can reactivate it\./u),
    ).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'Reactivate' }),
    ).not.toBeInTheDocument();
  });

  it('reads the workflow list but offers nothing that would change it', async () => {
    const requests = suspendedOwner();
    mockServer.use(
      http.get(`${API}/workflows`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    renderApp(`/w/${workspaceId}/workflows`);

    await waitFor(() => {
      expect(requests).toContain(`GET /v1/workspaces/${workspaceId}/workflows`);
    });
    expect(
      await screen.findByText(/This workspace is suspended\./u),
    ).toBeVisible();
    for (const name of [/New workflow/u, /Import/u, /New folder/u])
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });

  it('keeps the Connections page open, without its commands', async () => {
    suspendedOwner();
    mockServer.use(
      http.get(`${API}/connections`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    renderApp(`/w/${workspaceId}/connections`);

    expect(
      await screen.findByRole('heading', { name: 'Connections' }),
    ).toBeVisible();
    expect(
      screen.queryByText('Connections are unavailable'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Add connection/u }),
    ).not.toBeInTheDocument();
  });

  it('still reads alert destinations for someone who holds the capability', async () => {
    const requests = suspendedOwner();
    mockServer.use(
      http.get(`${API}/failure-notification-destinations`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get(`${API}/connections`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    renderApp(`/w/${workspaceId}/settings/alerts`);

    await waitFor(() => {
      expect(requests).toContain(
        `GET /v1/workspaces/${workspaceId}/failure-notification-destinations`,
      );
    });
    expect(
      screen.queryByText('Alerts are unavailable'),
    ).not.toBeInTheDocument();
  });
});
