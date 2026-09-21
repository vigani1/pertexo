import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const destinationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
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
  capabilities: [
    'workspace:read',
    'workflow:update',
    'connection:read',
    'connection:manage',
  ],
  createdAt: timestamp,
  updatedAt: timestamp,
};
const connection = {
  id: connectionId,
  workspaceId,
  providerKey: 'slack',
  name: 'Incident Slack',
  authType: 'slack_bot_token',
  status: 'active',
  secretVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  health: { lastTestedAt: null, lastHealthyAt: null, lastErrorCode: null },
  createdAt: timestamp,
  updatedAt: timestamp,
};

function destination(channelId = 'C0123456789', currentVersion = 1) {
  return {
    id: destinationId,
    workspaceId,
    kind: 'slack',
    status: 'enabled',
    currentVersion,
    config: { kind: 'slack', connectionId, channelId },
    createdAt: timestamp,
    updatedAt: timestamp,
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

function connectionHandler() {
  return http.get(
    `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
    () => HttpResponse.json({ items: [connection], nextCursor: null }),
  );
}

describe('failure notification destinations', () => {
  it('maps validation errors to their controls and focuses the first invalid field', async () => {
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations`,
        () => HttpResponse.json({ items: [] }),
      ),
    );
    renderApp(`/w/${workspaceId}/settings/notifications`);
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Add destination' }),
    );
    await actor.click(screen.getByRole('button', { name: 'Add destination' }));

    const connectionSelect = screen.getByLabelText('Slack connection');
    expect(connectionSelect).toHaveFocus();
    expect(connectionSelect).toHaveAttribute('aria-invalid', 'true');
    expect(connectionSelect).toHaveAccessibleDescription(
      'Choose an active slack connection.',
    );
    await actor.selectOptions(connectionSelect, connectionId);
    await actor.click(screen.getByRole('button', { name: 'Add destination' }));

    const target = screen.getByLabelText('Channel ID');
    expect(target).toHaveFocus();
    expect(target).toHaveAttribute('aria-invalid', 'true');
    expect(target).toHaveAccessibleDescription('Enter a Slack channel ID.');
    await actor.type(target, 'invalid');
    await actor.tab();
    expect(target).toHaveAccessibleDescription(
      'Enter a valid Slack channel ID.',
    );
    await actor.clear(target);
    await actor.type(target, 'C0123456789');
    expect(target).toHaveAttribute('aria-invalid', 'false');
  });

  it('creates with an exact uncertain retry and no credentials in the command', async () => {
    const requests: { key: string | null; body: unknown }[] = [];
    let created = false;
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations`,
        () => HttpResponse.json({ items: created ? [destination()] : [] }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations`,
        async ({ request }) => {
          requests.push({
            key: request.headers.get('idempotency-key'),
            body: await request.json(),
          });
          if (requests.length === 1) return HttpResponse.error();
          created = true;
          return HttpResponse.json(destination(), { status: 201 });
        },
      ),
    );

    renderApp(`/w/${workspaceId}/settings/notifications`, { strict: true });
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Add destination' }),
    );
    await actor.selectOptions(
      screen.getByLabelText('Slack connection'),
      connectionId,
    );
    await actor.type(screen.getByLabelText('Channel ID'), 'C0123456789');
    await actor.click(screen.getByRole('button', { name: 'Add destination' }));
    await actor.click(
      await screen.findByRole('button', { name: 'Retry safely' }),
    );

    expect(await screen.findByText('C0123456789')).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]?.body).toEqual({
      kind: 'slack',
      connectionId,
      channelId: 'C0123456789',
    });
    expect(JSON.stringify(requests)).not.toContain('xoxb-');
  });

  it('appends a version with the displayed precondition', async () => {
    let current = destination();
    let command: { key: string | null; body: unknown } | undefined;
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations`,
        () => HttpResponse.json({ items: [current] }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations/${destinationId}/versions`,
        async ({ request }) => {
          command = {
            key: request.headers.get('idempotency-key'),
            body: await request.json(),
          };
          current = destination('C9876543210', 2);
          return HttpResponse.json(current);
        },
      ),
    );

    renderApp(`/w/${workspaceId}/settings/notifications`);
    const actor = userEvent.setup();
    await actor.click(await screen.findByRole('button', { name: 'Edit' }));
    const channel = screen.getByLabelText('Channel ID');
    await actor.clear(channel);
    await actor.type(channel, 'C9876543210');
    await actor.click(screen.getByRole('button', { name: 'Save new version' }));

    expect(await screen.findByText('C9876543210')).toBeVisible();
    expect(command?.key).toBeTruthy();
    expect(command?.body).toEqual({
      expectedVersion: 1,
      config: {
        kind: 'slack',
        connectionId,
        channelId: 'C9876543210',
      },
    });
  });

  it('keeps the editing snapshot version while a background refetch advances the destination', async () => {
    let current = destination();
    let submittedBody: unknown;
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations`,
        () => HttpResponse.json({ items: [current] }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations/${destinationId}/versions`,
        async ({ request }) => {
          submittedBody = await request.json();
          return HttpResponse.json(destination('C9876543210', 3));
        },
      ),
    );

    const { queryClient } = renderApp(
      `/w/${workspaceId}/settings/notifications`,
    );
    const actor = userEvent.setup();
    await actor.click(await screen.findByRole('button', { name: 'Edit' }));
    current = destination('C0000000002', 2);
    await queryClient.invalidateQueries();
    await screen.findByText('C0000000002');
    const channel = screen.getByLabelText('Channel ID');
    await actor.clear(channel);
    await actor.type(channel, 'C9876543210');
    await actor.click(screen.getByRole('button', { name: 'Save new version' }));

    await waitFor(() => {
      expect(submittedBody).toEqual({
        expectedVersion: 1,
        config: {
          kind: 'slack',
          connectionId,
          channelId: 'C9876543210',
        },
      });
    });
  });

  it('retries the exact version command after a lost response and refetch', async () => {
    let current = destination();
    const commands: { key: string | null; body: unknown }[] = [];
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations`,
        () => HttpResponse.json({ items: [current] }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations/${destinationId}/versions`,
        async ({ request }) => {
          commands.push({
            key: request.headers.get('idempotency-key'),
            body: await request.json(),
          });
          current = destination('C9876543210', 2);
          if (commands.length === 1) return HttpResponse.error();
          return HttpResponse.json(current);
        },
      ),
    );

    const { queryClient } = renderApp(
      `/w/${workspaceId}/settings/notifications`,
      { strict: true },
    );
    const actor = userEvent.setup();
    await actor.click(await screen.findByRole('button', { name: 'Edit' }));
    const channel = screen.getByLabelText('Channel ID');
    await actor.clear(channel);
    await actor.type(channel, 'C9876543210');
    await actor.click(screen.getByRole('button', { name: 'Save new version' }));
    await screen.findByRole('button', { name: 'Retry safely' });
    await queryClient.invalidateQueries();
    await actor.click(screen.getByRole('button', { name: 'Retry safely' }));

    expect(await screen.findByText('C9876543210')).toBeVisible();
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[0]?.body).toEqual({
      expectedVersion: 1,
      config: {
        kind: 'slack',
        connectionId,
        channelId: 'C9876543210',
      },
    });
  });

  it('retries an uncertain status command with the same identity', async () => {
    const keys: (string | null)[] = [];
    let disabled = false;
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations`,
        () =>
          HttpResponse.json({
            items: [
              { ...destination(), status: disabled ? 'disabled' : 'enabled' },
            ],
          }),
      ),
      http.put(
        `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations/${destinationId}/status`,
        async ({ request }) => {
          keys.push(request.headers.get('idempotency-key'));
          expect(await request.json()).toEqual({ status: 'disabled' });
          disabled = true;
          if (keys.length === 1) return HttpResponse.error();
          return HttpResponse.json({ ...destination(), status: 'disabled' });
        },
      ),
    );

    const { queryClient } = renderApp(
      `/w/${workspaceId}/settings/notifications`,
      { strict: true },
    );
    const actor = userEvent.setup();
    await actor.click(await screen.findByRole('button', { name: 'Disable' }));
    await screen.findByRole('button', { name: 'Retry safely' });
    await queryClient.invalidateQueries();
    await waitFor(() => expect(screen.getByText('disabled')).toBeVisible());
    await actor.click(
      await screen.findByRole('button', { name: 'Retry safely' }),
    );
    await waitFor(() => expect(screen.getByText('disabled')).toBeVisible());
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('preserves a dirty row dialog through a recoverable background failure', async () => {
    let refreshFails = false;
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations`,
        () =>
          refreshFails
            ? HttpResponse.json(
                {
                  type: 'urn:pertexo:problem:internal.unexpected',
                  title: 'Unexpected server error',
                  status: 500,
                  code: 'internal.unexpected',
                  requestId: 'notification-refresh-failed',
                },
                {
                  status: 500,
                  headers: { 'content-type': 'application/problem+json' },
                },
              )
            : HttpResponse.json({ items: [destination()] }),
      ),
    );
    const { queryClient } = renderApp(
      `/w/${workspaceId}/settings/notifications`,
    );
    const actor = userEvent.setup();
    await actor.click(await screen.findByRole('button', { name: 'Edit' }));
    const channel = screen.getByLabelText('Channel ID');
    await actor.clear(channel);
    await actor.type(channel, 'C9999999999');

    refreshFails = true;
    await queryClient.invalidateQueries();
    const dialog = screen.getByRole('dialog');
    expect(
      await within(dialog).findByText(/destination list may be stale/u),
    ).toBeVisible();
    expect(dialog).toBeVisible();
    expect(channel).toHaveValue('C9999999999');

    refreshFails = false;
    await actor.click(
      within(dialog).getByRole('button', { name: 'Retry refresh' }),
    );
    await waitFor(() => {
      expect(
        within(dialog).queryByText(/destination list may be stale/u),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(channel).toHaveValue('C9999999999');
  });

  it('hides destination data and actions for a nondisclosing unavailable collection', async () => {
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations`,
        () =>
          HttpResponse.json(
            {
              type: 'urn:pertexo:problem:resource.not_found',
              title: 'Resource not found',
              status: 404,
              code: 'resource.not_found',
              requestId: 'notification-collection-unavailable',
            },
            {
              status: 404,
              headers: { 'content-type': 'application/problem+json' },
            },
          ),
      ),
    );
    renderApp(`/w/${workspaceId}/settings/notifications`);
    expect(
      await screen.findByRole('heading', {
        name: 'Notification destinations are unavailable',
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Add destination' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('C0123456789')).not.toBeInTheDocument();
  });

  it('does not load or advertise the page without workflow update access', async () => {
    let destinationReads = 0;
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        capabilities: ['workspace:read', 'connection:read'],
      }),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations`,
        () => {
          destinationReads += 1;
          return HttpResponse.json({ items: [] });
        },
      ),
    );

    renderApp(`/w/${workspaceId}/settings/notifications`);
    expect(
      await screen.findByRole('heading', {
        name: 'Notification destinations are unavailable',
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'Workspace settings' }),
    ).not.toBeInTheDocument();
    expect(destinationReads).toBe(0);
  });
});
