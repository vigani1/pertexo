import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';

// Each page loads its lazy route on first render; under a busy machine that
// can outlast the default one-second wait without anything being wrong.

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const timestamp = '2026-09-15T10:00:00.000Z';
const user = {
  id: userId,
  email: 'owner@example.test',
  displayName: 'Workspace Owner',
  status: 'active',
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const workspace = {
  id: workspaceId,
  name: 'Control Operations',
  slug: 'control-operations',
  status: 'active',
  revision: 1,
  role: 'owner',
  capabilities: ['workspace:read', 'workspace:manage', 'member:read'],
  createdAt: timestamp,
  updatedAt: timestamp,
};

function identityHandlers(currentWorkspace: unknown = workspace) {
  return [
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items: [currentWorkspace], nextCursor: null }),
    ),
  ];
}

function operation(
  status: 'pending' | 'running' | 'completed' | 'failed',
  commandType:
    'deletion_requested' | 'deletion_restored' = 'deletion_requested',
) {
  return {
    id: operationId,
    workspaceId,
    commandType,
    status,
    submittedAt: timestamp,
    updatedAt: timestamp,
    completedAt:
      status === 'completed' || status === 'failed' ? timestamp : null,
    errorCode: status === 'failed' ? 'workspace.lifecycle_failed' : null,
    result: status === 'completed' ? { workspaceId } : null,
  };
}

function problem(status: number, code: string, title: string) {
  return HttpResponse.json(
    {
      type: `https://pertexo.test/problems/${code}`,
      title,
      status,
      code,
      requestId: 'workspace-rename-test',
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

function renameResponse(current: typeof workspace, replayed: boolean) {
  return {
    workspace: {
      id: current.id,
      name: current.name,
      slug: current.slug,
      status: current.status,
      revision: current.revision,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
    },
    changed: true,
    replayed,
  };
}

describe('workspace settings', () => {
  it('renames in place and refreshes the authoritative shell in StrictMode', async () => {
    let authoritative = workspace;
    const commands: {
      body: unknown;
      csrf: string | null;
      key: string | null;
    }[] = [];
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [authoritative], nextCursor: null }),
      ),
      http.patch(
        `http://pertexo.test/v1/workspaces/${workspaceId}`,
        async ({ request }) => {
          commands.push({
            body: await request.json(),
            csrf: request.headers.get('x-csrf-token'),
            key: request.headers.get('idempotency-key'),
          });
          authoritative = {
            ...workspace,
            name: 'Incident Operations',
            revision: 2,
          };
          return HttpResponse.json(renameResponse(authoritative, false));
        },
      ),
    );
    renderApp(`/w/${workspaceId}/settings`, { strict: true });
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Rename workspace' }),
    );
    const input = screen.getByLabelText('Workspace name');
    await actor.clear(input);
    await actor.type(input, '{Enter}');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(commands).toHaveLength(0);
    await actor.type(input, '  Incident Operations  ');
    await actor.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('Renamed to Incident Operations'),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Rename workspace' }),
    ).toBeVisible();
    expect(commands).toHaveLength(1);
    expect(commands[0]?.body).toEqual({
      name: 'Incident Operations',
      expectedRevision: 1,
    });
    expect(commands[0]?.csrf).toBe(
      'csrf-token-for-component-tests-12345678901234567890',
    );
    expect(commands[0]?.key).toBeTruthy();
  });

  it('preserves the exact uncertain rename command for an explicit retry', async () => {
    let authoritative = workspace;
    const commands: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [authoritative], nextCursor: null }),
      ),
      http.patch(
        `http://pertexo.test/v1/workspaces/${workspaceId}`,
        async ({ request }) => {
          commands.push({
            body: await request.json(),
            key: request.headers.get('idempotency-key'),
          });
          if (commands.length === 1) return HttpResponse.error();
          authoritative = { ...workspace, name: 'Recovered name', revision: 2 };
          return HttpResponse.json(renameResponse(authoritative, true));
        },
      ),
    );
    renderApp(`/w/${workspaceId}/settings`);
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Rename workspace' }),
    );
    const input = screen.getByLabelText('Workspace name');
    await actor.clear(input);
    await actor.type(input, 'Recovered name');
    await actor.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We couldn’t confirm whether the rename went through',
    );
    expect(input).toBeDisabled();
    await actor.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      (await screen.findAllByText('Recovered name')).length,
    ).toBeGreaterThan(0);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(commands[1]);
  });

  it('refreshes a revision conflict and requires explicit reapplication with a new key', async () => {
    let authoritative = workspace;
    const commands: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [authoritative], nextCursor: null }),
      ),
      http.patch(
        `http://pertexo.test/v1/workspaces/${workspaceId}`,
        async ({ request }) => {
          commands.push({
            body: await request.json(),
            key: request.headers.get('idempotency-key'),
          });
          if (commands.length === 1) {
            authoritative = {
              ...workspace,
              name: 'Other tab name',
              revision: 2,
            };
            return problem(
              412,
              'workspace.revision_conflict',
              'Revision conflict',
            );
          }
          authoritative = {
            ...workspace,
            name: 'Reviewed local name',
            revision: 3,
          };
          return HttpResponse.json(renameResponse(authoritative, false));
        },
      ),
    );
    renderApp(`/w/${workspaceId}/settings`);
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Rename workspace' }),
    );
    const input = screen.getByLabelText('Workspace name');
    await actor.clear(input);
    await actor.type(input, 'Reviewed local name');
    await actor.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Renamed to “Other tab name” meanwhile.',
    );
    expect(input).toHaveValue('Reviewed local name');
    await actor.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(
      (await screen.findAllByText('Reviewed local name')).length,
    ).toBeGreaterThan(0);
    expect(commands.map((command) => command.body)).toEqual([
      { name: 'Reviewed local name', expectedRevision: 1 },
      { name: 'Reviewed local name', expectedRevision: 2 },
    ]);
    expect(commands[0]?.key).not.toBe(commands[1]?.key);
  });

  it('recovers discovery after an accepted rename without issuing the command again', async () => {
    let authoritative = workspace;
    let discoveryUnavailable = false;
    let patchCount = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        discoveryUnavailable
          ? problem(503, 'service.unavailable', 'Discovery unavailable')
          : HttpResponse.json({ items: [authoritative], nextCursor: null }),
      ),
      http.patch(`http://pertexo.test/v1/workspaces/${workspaceId}`, () => {
        patchCount += 1;
        discoveryUnavailable = true;
        return HttpResponse.json(
          renameResponse(
            { ...workspace, name: 'Durable rename', revision: 2 },
            false,
          ),
        );
      }),
    );
    renderApp(`/w/${workspaceId}/settings`);
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Rename workspace' }),
    );
    const input = screen.getByLabelText('Workspace name');
    await actor.clear(input);
    await actor.type(input, 'Durable rename');
    await actor.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The new name is saved, but this page couldn’t catch up',
    );

    authoritative = { ...workspace, name: 'Newer tab name', revision: 3 };
    discoveryUnavailable = false;
    await actor.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(
      (await screen.findAllByText('Newer tab name')).length,
    ).toBeGreaterThan(0);
    expect(patchCount).toBe(1);
  });

  it('blocks dispatch after an identity change and removes the prior workspace session', async () => {
    let userReads = 0;
    let patchCount = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () => {
        userReads += 1;
        return userReads === 1
          ? HttpResponse.json(user)
          : problem(401, 'auth.unauthenticated', 'Session changed');
      }),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [workspace], nextCursor: null }),
      ),
      http.patch(`http://pertexo.test/v1/workspaces/${workspaceId}`, () => {
        patchCount += 1;
        return HttpResponse.json(renameResponse(workspace, false));
      }),
    );
    renderApp(`/w/${workspaceId}/settings`);
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Rename workspace' }),
    );
    const input = screen.getByLabelText('Workspace name');
    await actor.clear(input);
    await actor.type(input, 'Must not dispatch');
    await actor.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByRole('heading', { name: 'Sign in to continue' }),
    ).toBeVisible();
    expect(patchCount).toBe(0);
  });

  it('removes rename actions after authoritative permission loss', async () => {
    let authorized = true;
    let patchCount = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({
          items: [
            authorized
              ? workspace
              : {
                  ...workspace,
                  role: 'viewer',
                  capabilities: ['workspace:read'],
                },
          ],
          nextCursor: null,
        }),
      ),
      http.patch(`http://pertexo.test/v1/workspaces/${workspaceId}`, () => {
        patchCount += 1;
        authorized = false;
        return problem(403, 'auth.forbidden', 'Access denied');
      }),
    );
    renderApp(`/w/${workspaceId}/settings`);
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Rename workspace' }),
    );
    const input = screen.getByLabelText('Workspace name');
    await actor.clear(input);
    await actor.type(input, 'Denied rename');
    await actor.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Rename workspace' }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: 'Delete workspace' }),
    ).not.toBeInTheDocument();
    expect(patchCount).toBe(1);
  });
  it('retries an uncertain deletion with the exact reason and key in StrictMode', async () => {
    const commands: { key: string | null; body: unknown }[] = [];
    let attempts = 0;
    mockServer.use(
      ...identityHandlers(),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/deletion`,
        async ({ request }) => {
          commands.push({
            key: request.headers.get('idempotency-key'),
            body: await request.json(),
          });
          attempts += 1;
          return attempts === 1
            ? HttpResponse.error()
            : HttpResponse.json(operation('pending'), { status: 202 });
        },
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/lifecycle-operations/${operationId}`,
        () => HttpResponse.json(operation('running')),
      ),
    );

    const { router } = renderApp(`/w/${workspaceId}/settings`, {
      strict: true,
    });
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Delete workspace' }),
    );
    const dialog = within(
      screen.getByRole('dialog', { name: 'Delete Control Operations?' }),
    );
    expect(dialog.getByText(/restore it for 30 days/u)).toBeVisible();
    const confirmation = dialog.getByLabelText(
      'Type “Control Operations” to confirm',
    );
    const reason = dialog.getByLabelText('Reason (required)');
    await actor.click(reason);
    await actor.tab();
    expect(
      dialog.queryByText(/Say why in a sentence/u),
    ).not.toBeInTheDocument();
    await actor.click(dialog.getByRole('button', { name: 'Delete workspace' }));
    expect(dialog.getByText(/Say why in a sentence/u)).toBeVisible();
    expect(confirmation).toHaveFocus();
    expect(confirmation).toHaveAccessibleDescription(
      'Type Control Operations exactly to confirm.',
    );
    await actor.type(confirmation, 'Control Operations');
    expect(confirmation).toHaveAttribute('aria-invalid', 'false');
    await actor.click(dialog.getByRole('button', { name: 'Delete workspace' }));
    expect(reason).toHaveFocus();
    await actor.type(reason, '   ');
    expect(dialog.getByText(/Say why in a sentence/u)).toBeVisible();
    await actor.clear(reason);
    await actor.type(reason, 'No longer needed');
    await actor.click(dialog.getByRole('button', { name: 'Delete workspace' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'We couldn’t confirm whether the deletion request went through',
    );
    expect(reason).toBeDisabled();
    await actor.click(dialog.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Running')).toBeVisible();
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(commands[1]);
    expect(commands[0]?.body).toEqual({ reason: 'No longer needed' });
    await waitFor(() => {
      expect(router.state.location.search.operationId).toBe(operationId);
    });
  });

  it('resumes and exposes a failed operation until explicit dismissal', async () => {
    mockServer.use(
      ...identityHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/lifecycle-operations/${operationId}`,
        () => HttpResponse.json(operation('failed')),
      ),
    );
    const { router } = renderApp(
      `/w/${workspaceId}/settings?operationId=${operationId}`,
    );
    expect(await screen.findByText('Failed')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The deletion didn’t finish, so nothing changed.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent(
      'workspace.lifecycle_failed',
    );
    expect(screen.getByText('workspace.lifecycle_failed')).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(
      await screen.findByRole('button', { name: 'Delete workspace' }),
    ).toBeVisible();
    await waitFor(() => {
      expect(router.state.location.search.operationId).toBeUndefined();
    });
  });

  it('refreshes authoritative workspace state when an operation completes', async () => {
    let workspaceReads = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () => {
        workspaceReads += 1;
        return HttpResponse.json({
          items: [
            {
              ...workspace,
              status: workspaceReads === 1 ? 'active' : 'pending_deletion',
            },
          ],
          nextCursor: null,
        });
      }),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/lifecycle-operations/${operationId}`,
        () => HttpResponse.json(operation('completed')),
      ),
    );
    renderApp(`/w/${workspaceId}/settings?operationId=${operationId}`);
    expect(await screen.findByText('Done')).toBeVisible();
    await waitFor(() => {
      expect(workspaceReads).toBeGreaterThanOrEqual(2);
      expect(screen.getByRole('link', { name: 'Restore' })).toBeVisible();
    });
  });

  it('restores a pending-deletion workspace with a durable command', async () => {
    let deletes = 0;
    mockServer.use(
      ...identityHandlers({ ...workspace, status: 'pending_deletion' }),
      http.delete(
        `http://pertexo.test/v1/workspaces/${workspaceId}/deletion`,
        ({ request }) => {
          deletes += 1;
          expect(request.headers.get('idempotency-key')).toBeTruthy();
          return HttpResponse.json(operation('pending', 'deletion_restored'), {
            status: 202,
          });
        },
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/lifecycle-operations/${operationId}`,
        () => HttpResponse.json(operation('running', 'deletion_restored')),
      ),
    );
    renderApp(`/w/${workspaceId}/settings`);
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Restore workspace' }),
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Restore Control Operations?',
    });
    expect(dialog).toHaveTextContent(/integrations stay off/u);
    await actor.click(
      within(dialog).getByRole('button', { name: 'Restore workspace' }),
    );
    expect(await screen.findByText('Restoring the workspace')).toBeVisible();
    expect(deletes).toBe(1);
  });

  it('counts what lives in the workspace, each tile opening its page', async () => {
    const api = `http://pertexo.test/v1/workspaces/${workspaceId}`;
    const workflow = (id: string, overrides: Record<string, unknown>) => ({
      id,
      workspaceId,
      name: `Workflow ${id.slice(0, 2)}`,
      nameRevision: 1,
      lifecycleStatus: 'active',
      lifecycleRevision: 1,
      activationStatus: 'active',
      publishedVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      createdAt: timestamp,
      updatedAt: timestamp,
      ...overrides,
    });
    const person = (id: string, role: string) => ({
      userId: id,
      email: `${id.slice(0, 8)}@example.test`,
      displayName: `Person ${id.slice(0, 2)}`,
      role,
      roleRevision: 1,
      membershipStatus: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        capabilities: [
          'workspace:read',
          'workspace:manage',
          'member:read',
          'workflow:read',
          'workflow:update',
          'connection:read',
        ],
      }),
      http.get(`${api}/workflows`, () =>
        HttpResponse.json({
          items: [
            workflow('11111111-1111-4111-8111-111111111111', {}),
            workflow('22222222-2222-4222-8222-222222222222', {
              publishedVersionId: null,
              activationStatus: 'inactive',
            }),
            workflow('33333333-3333-4333-8333-333333333333', {
              lifecycleStatus: 'archived',
            }),
          ],
          nextCursor: null,
        }),
      ),
      http.get(`${api}/members`, () =>
        HttpResponse.json({
          items: [
            person(userId, 'owner'),
            person('44444444-4444-4444-8444-444444444444', 'builder'),
            person('55555555-5555-4555-8555-555555555555', 'builder'),
          ],
          nextCursor: null,
        }),
      ),
      http.get(`${api}/connections`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get(`${api}/failure-notification-destinations`, () =>
        HttpResponse.json({ items: [] }),
      ),
    );
    renderApp(`/w/${workspaceId}/settings`);
    const glance = within(
      await screen.findByRole('region', { name: 'At a glance' }),
    );
    const tile = (name: RegExp) => glance.getByRole('link', { name });
    await waitFor(() => {
      expect(tile(/workflows/u)).toHaveTextContent('2workflows');
    });
    expect(tile(/workflows/u)).toHaveTextContent('1 live1 draft');
    expect(tile(/workflows/u)).toHaveTextContent('1 archived');
    expect(tile(/workflows/u)).toHaveAttribute(
      'href',
      `/w/${workspaceId}/workflows`,
    );
    await waitFor(() => {
      expect(tile(/members/u)).toHaveTextContent('1 Owner · 2 Builders');
    });
    expect(tile(/members/u)).toHaveAttribute('href', `/w/${workspaceId}/team`);
    await waitFor(() => {
      expect(tile(/connections/u)).toHaveTextContent('Nothing connected yet');
    });
    expect(tile(/alert destinations/u)).toHaveAttribute(
      'href',
      `/w/${workspaceId}/alerts`,
    );
  });

  it('shows read-only identity without management commands when capability is absent', async () => {
    let requests = 0;
    mockServer.use(
      ...identityHandlers({ ...workspace, capabilities: ['workspace:read'] }),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/deletion`,
        () => {
          requests += 1;
          return HttpResponse.json(operation('pending'), { status: 202 });
        },
      ),
    );
    renderApp(`/w/${workspaceId}/settings`);
    expect(
      await screen.findByRole('heading', { name: 'Workspace' }),
    ).toBeVisible();
    expect(screen.getAllByText('Control Operations').length).toBeGreaterThan(0);
    expect(screen.getByText('control-operations')).toBeVisible();
    expect(screen.getByText('You’re an Owner here.')).toBeVisible();
    // Access follows what the workspace grants, not the role's name alone.
    const access = within(screen.getByRole('region', { name: 'Your access' }));
    expect(
      access.getByText('See workflows, runs and connections'),
    ).toHaveTextContent('See workflows, runs and connections');
    expect(access.getAllByText(': not with your role')).toHaveLength(7);
    expect(
      screen.getByRole('button', { name: /^Copy workspace ID / }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Rename workspace' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete workspace' }),
    ).not.toBeInTheDocument();
    expect(requests).toBe(0);
  });
});
