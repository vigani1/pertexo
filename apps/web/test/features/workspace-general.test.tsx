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

describe('workspace general settings', () => {
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

  it('does not advertise or request lifecycle commands without manage capability', async () => {
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
      await screen.findByRole('heading', {
        name: 'Workspace settings are unavailable',
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Request deletion' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Workspace settings' }),
    ).not.toBeInTheDocument();
    expect(requests).toBe(0);
  });
});
