import { HttpResponse, http } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const timestamp = '2026-09-15T10:00:00.000Z';
const user = {
  id: userId,
  email: 'owner@example.test',
  displayName: 'Workspace Owner',
  status: 'active',
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

describe('workspace general settings', () => {
  it('renames from General and refreshes the authoritative shell in StrictMode', async () => {
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
    renderApp(`/w/${workspaceId}/settings/general`, { strict: true });
    const actor = userEvent.setup();
    await actor.click(await screen.findByRole('button', { name: 'Edit name' }));
    const input = screen.getByLabelText('Display name');
    await actor.clear(input);
    await actor.type(input, '{Enter}');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(commands).toHaveLength(0);
    await actor.type(input, '  Incident Operations  ');
    await actor.click(screen.getByRole('button', { name: 'Save name' }));

    expect(
      (await screen.findAllByText('Incident Operations')).length,
    ).toBeGreaterThan(0);
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
    renderApp(`/w/${workspaceId}/settings/general`);
    const actor = userEvent.setup();
    await actor.click(await screen.findByRole('button', { name: 'Edit name' }));
    const input = screen.getByLabelText('Display name');
    await actor.clear(input);
    await actor.type(input, 'Recovered name');
    await actor.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The rename result is uncertain',
    );
    expect(input).toBeDisabled();
    await actor.click(
      screen.getByRole('button', { name: 'Retry exact rename' }),
    );
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
    renderApp(`/w/${workspaceId}/settings/general`);
    const actor = userEvent.setup();
    await actor.click(await screen.findByRole('button', { name: 'Edit name' }));
    const input = screen.getByLabelText('Display name');
    await actor.clear(input);
    await actor.type(input, 'Reviewed local name');
    await actor.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText(/workspace changed since/u)).toBeVisible();
    await actor.click(
      screen.getByRole('button', { name: 'Refresh workspace' }),
    );
    expect(
      (await screen.findAllByText(/Other tab name/u)).length,
    ).toBeGreaterThan(0);
    await actor.click(
      screen.getByRole('button', { name: 'Reapply against latest' }),
    );
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
    renderApp(`/w/${workspaceId}/settings/general`);
    const actor = userEvent.setup();
    await actor.click(await screen.findByRole('button', { name: 'Edit name' }));
    const input = screen.getByLabelText('Display name');
    await actor.clear(input);
    await actor.type(input, 'Durable rename');
    await actor.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'workspace access could not be refreshed',
    );

    authoritative = { ...workspace, name: 'Newer tab name', revision: 3 };
    discoveryUnavailable = false;
    await actor.click(
      screen.getByRole('button', { name: 'Refresh workspace access' }),
    );
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
    renderApp(`/w/${workspaceId}/settings/general`);
    const actor = userEvent.setup();
    await actor.click(await screen.findByRole('button', { name: 'Edit name' }));
    const input = screen.getByLabelText('Display name');
    await actor.clear(input);
    await actor.type(input, 'Must not dispatch');
    await actor.click(screen.getByRole('button', { name: 'Save name' }));

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
    renderApp(`/w/${workspaceId}/settings/general`);
    const actor = userEvent.setup();
    await actor.click(await screen.findByRole('button', { name: 'Edit name' }));
    const input = screen.getByLabelText('Display name');
    await actor.clear(input);
    await actor.type(input, 'Denied rename');
    await actor.click(screen.getByRole('button', { name: 'Save name' }));

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Edit name' }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: 'Request deletion' }),
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

    const { router } = renderApp(`/w/${workspaceId}/settings/general`, {
      strict: true,
    });
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Request deletion' }),
    );
    const reason = screen.getByLabelText('Reason');
    await actor.click(reason);
    await actor.tab();
    expect(
      await screen.findByText('Enter a reason between 1 and 512 characters.'),
    ).toBeVisible();
    await actor.type(reason, '   ');
    expect(
      screen.getByText('Enter a reason between 1 and 512 characters.'),
    ).toBeVisible();
    await actor.clear(reason);
    await actor.click(screen.getByRole('button', { name: 'Request deletion' }));
    expect(screen.getByLabelText('Reason')).toHaveFocus();
    expect(screen.getByLabelText('Reason')).toHaveAttribute(
      'aria-describedby',
      'workspace-deletion-description workspace-deletion-error',
    );
    await actor.type(reason, '   ');
    expect(
      screen.getByText('Enter a reason between 1 and 512 characters.'),
    ).toBeVisible();
    await actor.clear(reason);
    await actor.type(reason, 'No longer needed');
    await actor.click(screen.getByRole('button', { name: 'Request deletion' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The result is uncertain.',
    );
    expect(screen.getByLabelText('Reason')).toBeDisabled();
    await actor.click(screen.getByRole('button', { name: 'Retry request' }));

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
      `/w/${workspaceId}/settings/general?operationId=${operationId}`,
    );
    expect(await screen.findByText('Failed')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'workspace.lifecycle_failed',
    );
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Dismiss operation' }));
    expect(
      await screen.findByRole('button', { name: 'Request deletion' }),
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
    renderApp(`/w/${workspaceId}/settings/general?operationId=${operationId}`);
    expect(await screen.findByText('Completed')).toBeVisible();
    await waitFor(() => {
      expect(workspaceReads).toBeGreaterThanOrEqual(2);
      expect(screen.getByText('pending deletion')).toBeVisible();
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
    renderApp(`/w/${workspaceId}/settings/general`);
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Restore workspace' }),
    );
    await actor.click(
      screen.getByRole('button', { name: 'Restore workspace' }),
    );
    expect(await screen.findByText('Workspace restore')).toBeVisible();
    expect(deletes).toBe(1);
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
    renderApp(`/w/${workspaceId}/settings/general`);
    expect(
      await screen.findByRole('heading', { name: 'General' }),
    ).toBeVisible();
    expect(screen.getAllByText('Control Operations').length).toBeGreaterThan(0);
    expect(
      screen.queryByRole('button', { name: 'Edit name' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Request deletion' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'General' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(requests).toBe(0);
  });
});
