import { HttpResponse, http } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
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
    'connection:read',
    'connection:use',
    'connection:manage',
  ],
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};

function connection(name: string) {
  return {
    id: connectionId,
    workspaceId,
    providerKey: 'slack',
    name,
    authType: 'slack_bot_token',
    status: 'active',
    secretVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    health: { lastTestedAt: null, lastHealthyAt: null, lastErrorCode: null },
    createdAt: '2026-09-15T10:00:00.000Z',
    updatedAt: '2026-09-15T10:00:00.000Z',
  };
}

function identityHandlers(currentWorkspace: unknown = workspace) {
  return [
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items: [currentWorkspace], nextCursor: null }),
    ),
  ];
}

function unavailableCollection() {
  return HttpResponse.json(
    {
      type: 'urn:pertexo:problem:resource.not_found',
      title: 'Resource not found',
      status: 404,
      code: 'resource.not_found',
      requestId: 'request-connections-not-found',
    },
    { status: 404, headers: { 'content-type': 'application/problem+json' } },
  );
}

describe('connections page', () => {
  it('recovers from a network refresh failure and hides protected data after a nondisclosing 404', async () => {
    let response: 'ok' | 'failed' | 'unavailable' = 'ok';
    mockServer.use(
      ...identityHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        () => {
          if (response === 'failed') return HttpResponse.error();
          if (response === 'unavailable') return unavailableCollection();
          return HttpResponse.json({
            items: [connection('Primary Slack')],
            nextCursor: null,
          });
        },
      ),
    );
    const { queryClient } = renderApp(`/w/${workspaceId}/connections`);
    expect(await screen.findByText('Primary Slack')).toBeVisible();

    response = 'failed';
    await queryClient.refetchQueries({
      queryKey: ['identity', userId, 'workspace', workspaceId, 'connections'],
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'These connections may be stale',
    );
    expect(screen.getByText('Primary Slack')).toBeVisible();

    response = 'ok';
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Retry refresh' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    response = 'unavailable';
    await queryClient.refetchQueries({
      queryKey: ['identity', userId, 'workspace', workspaceId, 'connections'],
    });
    expect(
      await screen.findByRole('heading', {
        name: 'Connections are unavailable',
      }),
    ).toBeVisible();
    expect(screen.getByText(/may not exist/iu)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Add connection' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Primary Slack')).not.toBeInTheDocument();
  });

  it('paginates safe connection metadata', async () => {
    mockServer.use(
      ...identityHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        ({ request }) =>
          HttpResponse.json(
            new URL(request.url).searchParams.get('after') === null
              ? { items: [connection('Primary Slack')], nextCursor: 'next' }
              : {
                  items: [
                    {
                      ...connection('Incident Slack'),
                      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
                    },
                  ],
                  nextCursor: null,
                },
          ),
      ),
    );

    renderApp(`/w/${workspaceId}/connections`);
    expect(await screen.findByText('Primary Slack')).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Incident Slack')).toBeVisible();
    expect(screen.queryByText(/xoxb-/u)).not.toBeInTheDocument();
  });

  it('validates creation and safely retries the exact uncertain command in StrictMode', async () => {
    const token = 'xoxb-1234567890-secret';
    const keys: string[] = [];
    let created = false;
    mockServer.use(
      ...identityHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        () =>
          HttpResponse.json({
            items: created ? [connection('Operations Slack')] : [],
            nextCursor: null,
          }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        async ({ request }) => {
          keys.push(request.headers.get('idempotency-key') ?? '');
          expect(request.headers.get('x-csrf-token')).toBe(
            'csrf-token-for-component-tests-12345678901234567890',
          );
          expect(await request.json()).toEqual({
            providerKey: 'slack',
            name: 'Operations Slack',
            credential: {
              schemaVersion: 1,
              type: 'slack_bot_token',
              botToken: token,
            },
          });
          if (keys.length === 1) return HttpResponse.error();
          created = true;
          return HttpResponse.json(connection('Operations Slack'), {
            status: 201,
          });
        },
      ),
    );

    const { queryClient } = renderApp(`/w/${workspaceId}/connections`, {
      strict: true,
    });
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Add connection' }),
    );
    const nameInput = screen.getByLabelText('Connection name');
    const tokenInput = screen.getByLabelText('Slack bot token');
    await event.click(nameInput);
    await event.tab();
    expect(await screen.findByText('Enter a connection name.')).toBeVisible();
    await event.type(nameInput, '   ');
    expect(screen.getByText('Enter a connection name.')).toBeVisible();
    await event.clear(nameInput);
    await event.click(screen.getByRole('button', { name: 'Add connection' }));
    expect(await screen.findByText('Enter a connection name.')).toBeVisible();
    expect(
      screen.getByText('Enter a Slack bot token beginning with xoxb-.'),
    ).toBeVisible();
    expect(screen.getByLabelText('Connection name')).toHaveFocus();
    expect(screen.getByLabelText('Connection name')).toHaveAttribute(
      'aria-describedby',
      'slack-name-help slack-name-error',
    );
    await event.type(nameInput, '  Operations Slack  ');
    await event.type(tokenInput, 'wrong');
    expect(
      screen.getByText('Enter a Slack bot token beginning with xoxb-.'),
    ).toBeVisible();
    await event.clear(tokenInput);
    await event.type(tokenInput, token);
    await event.click(screen.getByRole('button', { name: 'Add connection' }));
    expect(
      await screen.findByRole('button', { name: 'Retry safely' }),
    ).toBeVisible();
    expect(screen.getByLabelText('Connection name')).toHaveAttribute(
      'aria-invalid',
      'false',
    );
    expect(screen.getByLabelText('Slack bot token')).toHaveAttribute(
      'aria-invalid',
      'false',
    );
    await event.click(screen.getByRole('button', { name: 'Retry safely' }));
    expect(await screen.findByText('Operations Slack')).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(screen.queryByText(token)).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.variables),
      ),
    ).not.toContain(token);
  });

  it('removes a pending credential command from the mutation cache on unmount', async () => {
    const token = 'xoxb-1234567890-pending';
    let releaseRequest: (() => void) | undefined;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    mockServer.use(
      ...identityHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        () => HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        async () => {
          await requestGate;
          return HttpResponse.json(connection('Pending Slack'), {
            status: 201,
          });
        },
      ),
    );

    const rendered = renderApp(`/w/${workspaceId}/connections`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Add connection' }),
    );
    await event.type(screen.getByLabelText('Connection name'), 'Pending Slack');
    await event.type(screen.getByLabelText('Slack bot token'), token);
    await event.click(screen.getByRole('button', { name: 'Add connection' }));
    await waitFor(() => {
      expect(
        JSON.stringify(
          rendered.queryClient
            .getMutationCache()
            .getAll()
            .map((mutation) => mutation.state.variables),
        ),
      ).toContain(token);
    });

    rendered.unmount();
    expect(
      JSON.stringify(
        rendered.queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.variables),
      ),
    ).not.toContain(token);
    releaseRequest?.();
  });

  it('removes an uncertain credential command after explicit discard', async () => {
    const token = 'xoxb-1234567890-discard';
    mockServer.use(
      ...identityHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        () => HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        () => HttpResponse.error(),
      ),
    );

    const { queryClient } = renderApp(`/w/${workspaceId}/connections`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Add connection' }),
    );
    await event.type(screen.getByLabelText('Connection name'), 'Discard Slack');
    await event.type(screen.getByLabelText('Slack bot token'), token);
    await event.click(screen.getByRole('button', { name: 'Add connection' }));
    await screen.findByRole('button', { name: 'Retry safely' });
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.variables),
      ),
    ).toContain(token);

    await event.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByDisplayValue(token)).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.variables),
      ),
    ).not.toContain(token);
  });

  it('retries the same connection test command and shows the provider outcome', async () => {
    const keys: string[] = [];
    mockServer.use(
      ...identityHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        () =>
          HttpResponse.json({
            items: [connection('Operations Slack')],
            nextCursor: null,
          }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections/${connectionId}/test`,
        async ({ request }) => {
          keys.push(request.headers.get('idempotency-key') ?? '');
          expect(await request.json()).toEqual({ providerKey: 'slack' });
          if (keys.length === 1) return HttpResponse.error();
          return HttpResponse.json({
            connection: {
              ...connection('Operations Slack'),
              health: {
                lastTestedAt: '2026-09-15T11:00:00.000Z',
                lastHealthyAt: '2026-09-15T11:00:00.000Z',
                lastErrorCode: null,
              },
            },
            outcome: { ok: true, httpStatus: 200, errorCode: null },
          });
        },
      ),
    );

    renderApp(`/w/${workspaceId}/connections`, { strict: true });
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'Test' }));
    expect(
      await screen.findByText(
        'The test result is uncertain. Retry to observe the same test command.',
      ),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Retry test' }));
    expect(await screen.findByText('Connection test passed.')).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('rotates a Slack token with its original precondition and command key', async () => {
    const nextToken = 'xoxb-1234567890-rotated';
    const keys: string[] = [];
    const bodies: unknown[] = [];
    let rotated = false;
    mockServer.use(
      ...identityHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        () =>
          HttpResponse.json({
            items: [
              {
                ...connection('Operations Slack'),
                secretVersionId: rotated
                  ? 'ffffffff-ffff-4fff-8fff-ffffffffffff'
                  : 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              },
            ],
            nextCursor: null,
          }),
      ),
      http.put(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections/${connectionId}/secret`,
        async ({ request }) => {
          keys.push(request.headers.get('idempotency-key') ?? '');
          bodies.push(await request.json());
          if (keys.length === 1) return HttpResponse.error();
          rotated = true;
          return HttpResponse.json({
            ...connection('Operations Slack'),
            secretVersionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          });
        },
      ),
    );

    const { queryClient } = renderApp(`/w/${workspaceId}/connections`, {
      strict: true,
    });
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Rotate token' }),
    );
    const tokenInput = screen.getByLabelText('New Slack bot token');
    await event.click(tokenInput);
    await event.tab();
    expect(
      await screen.findByText('Enter a Slack bot token beginning with xoxb-.'),
    ).toBeVisible();
    await event.type(tokenInput, 'wrong');
    expect(
      screen.getByText('Enter a Slack bot token beginning with xoxb-.'),
    ).toBeVisible();
    await event.clear(tokenInput);
    await event.click(screen.getByRole('button', { name: 'Rotate token' }));
    expect(screen.getByLabelText('New Slack bot token')).toHaveFocus();
    expect(screen.getByLabelText('New Slack bot token')).toHaveAttribute(
      'aria-describedby',
      expect.stringContaining('-error'),
    );
    await event.type(tokenInput, 'still-wrong');
    expect(
      screen.getByText('Enter a Slack bot token beginning with xoxb-.'),
    ).toBeVisible();
    await event.clear(tokenInput);
    await event.type(tokenInput, nextToken);
    await event.click(screen.getByRole('button', { name: 'Rotate token' }));
    expect(
      await screen.findByText(
        'The rotation result is uncertain. Retry without changing the token to reuse this command safely.',
      ),
    ).toBeVisible();
    expect(screen.getByLabelText('New Slack bot token')).toHaveAttribute(
      'aria-invalid',
      'false',
    );
    await event.click(screen.getByRole('button', { name: 'Retry safely' }));
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', {
          name: 'Rotate Operations Slack token',
        }),
      ).not.toBeInTheDocument();
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0]).toEqual({
      expectedSecretVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      credential: {
        schemaVersion: 1,
        type: 'slack_bot_token',
        botToken: nextToken,
      },
    });
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.variables),
      ),
    ).not.toContain(nextToken);
  });

  it('explains revocation, supports Escape, and refreshes the confirmed status', async () => {
    let revoked = false;
    let commands = 0;
    mockServer.use(
      ...identityHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        () =>
          HttpResponse.json({
            items: [
              {
                ...connection('Operations Slack'),
                status: revoked ? 'revoked' : 'active',
              },
            ],
            nextCursor: null,
          }),
      ),
      http.delete(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections/${connectionId}`,
        () => {
          commands += 1;
          revoked = true;
          return HttpResponse.json({
            ...connection('Operations Slack'),
            status: 'revoked',
          });
        },
      ),
    );

    renderApp(`/w/${workspaceId}/connections`);
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(
      screen.getByText(
        /Historical workflow and run references are not erased/u,
      ),
    ).toBeVisible();
    await event.keyboard('{Escape}');
    expect(
      screen.queryByRole('heading', { name: 'Revoke Operations Slack?' }),
    ).not.toBeInTheDocument();
    expect(commands).toBe(0);
    await event.click(screen.getByRole('button', { name: 'Revoke' }));
    await event.click(
      screen.getByRole('button', { name: 'Revoke connection' }),
    );
    expect(await screen.findByText('revoked')).toBeVisible();
    expect(commands).toBe(1);
  });

  it('keeps read-only access free of management controls', async () => {
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        role: 'viewer',
        capabilities: ['workspace:read', 'connection:read'],
      }),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        () =>
          HttpResponse.json({
            items: [connection('Read only Slack')],
            nextCursor: null,
          }),
      ),
    );
    renderApp(`/w/${workspaceId}/connections`);
    expect(await screen.findByText('Read only Slack')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /add.*connection/iu }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Test' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Rotate token' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Revoke' }),
    ).not.toBeInTheDocument();
  });

  it('keeps a failed list distinct from an empty workspace and offers retry', async () => {
    mockServer.use(
      ...identityHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        () => HttpResponse.error(),
      ),
    );
    renderApp(`/w/${workspaceId}/connections`);
    expect(
      await screen.findByRole('heading', {
        name: 'Connections are unavailable',
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'No connections yet' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('clears transient credentials when an uncertain attempt is dismissed', async () => {
    mockServer.use(
      ...identityHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        () => HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        () => HttpResponse.error(),
      ),
    );
    renderApp(`/w/${workspaceId}/connections`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Add connection' }),
    );
    await event.type(screen.getByLabelText('Connection name'), 'Temporary');
    await event.type(
      screen.getByLabelText('Slack bot token'),
      'xoxb-1234567890-temporary',
    );
    await event.click(screen.getByRole('button', { name: 'Add connection' }));
    expect(
      await screen.findByRole('button', { name: 'Retry safely' }),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Cancel' }));
    await event.click(screen.getByRole('button', { name: 'Add connection' }));
    expect(screen.getByLabelText('Connection name')).toHaveValue('');
    expect(screen.getByLabelText('Slack bot token')).toHaveValue('');
    expect(
      screen.queryByRole('button', { name: 'Retry safely' }),
    ).not.toBeInTheDocument();
  });

  it('does not request connection data without read permission', async () => {
    let reads = 0;
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        role: 'viewer',
        capabilities: ['workspace:read'],
      }),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        () => {
          reads += 1;
          return HttpResponse.json({ items: [], nextCursor: null });
        },
      ),
    );
    renderApp(`/w/${workspaceId}/connections`);
    expect(
      await screen.findByText(
        'Your workspace role does not allow you to view stored connections.',
      ),
    ).toBeVisible();
    await waitFor(() => {
      expect(reads).toBe(0);
    });
    expect(
      screen.queryByRole('link', { name: 'Connections' }),
    ).not.toBeInTheDocument();
  });
});
