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
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const destinationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const timestamp = '2026-09-15T10:00:00.000Z';
const destinationsUrl = `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations`;
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

function destination(
  channelId = 'C0123456789',
  currentVersion = 1,
  status: 'enabled' | 'disabled' = 'enabled',
) {
  return {
    id: destinationId,
    workspaceId,
    kind: 'slack',
    status,
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

function destinationsOf(
  items: () => readonly ReturnType<typeof destination>[],
) {
  return http.get(destinationsUrl, () => HttpResponse.json({ items: items() }));
}

function problem(status: number, code: string) {
  return HttpResponse.json(
    {
      type: `urn:pertexo:problem:${code}`,
      title: 'Problem',
      status,
      code,
      requestId: `request-${code}`,
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

function lens() {
  const sheet = document.querySelector<HTMLElement>(
    '[data-slot="sheet-content"]',
  );
  if (sheet === null) throw new Error('No lens is open.');
  return within(sheet);
}

async function chooseConnection(actor: ReturnType<typeof userEvent.setup>) {
  await actor.click(lens().getByLabelText('Slack connection'));
  await actor.click(
    await screen.findByRole('option', { name: 'Incident Slack' }),
  );
}

describe('alert destinations', () => {
  it('names each destination in words with a success-toned Enabled switch', async () => {
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      destinationsOf(() => [destination()]),
    );
    renderApp(`/w/${workspaceId}/alerts`);
    expect(
      await screen.findByText('#C0123456789 via Incident Slack'),
    ).toBeVisible();
    const toggle = screen.getByRole('switch', {
      name: 'Send alerts to #C0123456789 via Incident Slack',
    });
    expect(toggle).toBeChecked();
    expect(toggle.className).toContain('data-checked:bg-success');
    expect(screen.queryByText(/Version 1/u)).not.toBeInTheDocument();
  });

  it('shows channel names from one bounded lookup per connection, and the ID with why when a name is unknown', async () => {
    const lookups: string[] = [];
    const second = {
      ...destination('C0404'),
      id: '12121212-1212-4212-8212-121212121212',
    };
    const direct = {
      ...destination('D0999'),
      id: '34343434-3434-4434-8434-343434343434',
    };
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        capabilities: [...workspace.capabilities, 'connection:use'],
      }),
      connectionHandler(),
      destinationsOf(() => [destination(), second, direct]),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections/${connectionId}/slack/channels`,
        ({ request }) => {
          const channelIds =
            new URL(request.url).searchParams.get('channelIds') ?? '';
          lookups.push(channelIds);
          return HttpResponse.json({
            items: channelIds.split(',').map((channelId) =>
              channelId === 'C0123456789'
                ? { channelId, status: 'resolved', name: 'ops-alerts' }
                : {
                    channelId,
                    status: 'unresolved',
                    reason:
                      channelId === 'C0404' ? 'missing_scope' : 'not_a_channel',
                  },
            ),
          });
        },
      ),
    );
    renderApp(`/w/${workspaceId}/alerts`);

    expect(
      await screen.findByText('#ops-alerts via Incident Slack'),
    ).toBeVisible();
    expect(screen.getByText('#C0404 via Incident Slack')).toBeVisible();
    expect(
      screen.getByText(
        /Showing the channel ID\. The Slack app needs the channels:read scope/u,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        'Showing the channel ID. Direct messages don’t have channel names.',
      ),
    ).toBeVisible();
    expect(lookups).toEqual(['C0123456789,C0404,D0999']);

    const actor = userEvent.setup();
    await actor.click(
      screen.getByRole('button', {
        name: 'Edit #ops-alerts via Incident Slack',
      }),
    );
    const channel = lens().getByLabelText('Channel ID');
    expect(channel).toHaveValue('C0123456789');
    expect(channel).toHaveAccessibleDescription(
      expect.stringMatching(/^Posts to #ops-alerts\. In Slack/u),
    );
    await actor.clear(channel);
    await actor.type(channel, 'C0000000001');
    expect(channel).not.toHaveAccessibleDescription(
      expect.stringContaining('#ops-alerts'),
    );
  });

  it('keeps the page and channel IDs when the name lookup fails', async () => {
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        capabilities: [...workspace.capabilities, 'connection:use'],
      }),
      connectionHandler(),
      destinationsOf(() => [destination()]),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections/${connectionId}/slack/channels`,
        () => problem(429, 'rate_limit.exceeded'),
      ),
    );
    renderApp(`/w/${workspaceId}/alerts`);

    expect(
      await screen.findByText(
        'Showing the channel ID. Channel names couldn’t be looked up right now.',
      ),
    ).toBeVisible();
    expect(screen.getByText('#C0123456789 via Incident Slack')).toBeVisible();
    expect(
      screen.getByRole('switch', {
        name: 'Send alerts to #C0123456789 via Incident Slack',
      }),
    ).toBeChecked();
  });

  it('offers Add destination from the empty state and validates fields in order', async () => {
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      destinationsOf(() => []),
    );
    renderApp(`/w/${workspaceId}/alerts`);
    const actor = userEvent.setup();
    expect(
      await screen.findByRole('heading', { name: 'No alert destinations yet' }),
    ).toBeVisible();
    await actor.click(screen.getByRole('button', { name: 'Add destination' }));
    await actor.click(lens().getByRole('button', { name: 'Add destination' }));

    const connectionSelect = lens().getByLabelText('Slack connection');
    expect(connectionSelect).toHaveFocus();
    expect(connectionSelect).toHaveAttribute('aria-invalid', 'true');
    expect(connectionSelect).toHaveAccessibleDescription(
      'Choose the Slack connection that posts the alert.',
    );
    await chooseConnection(actor);
    expect(connectionSelect).toHaveAttribute('aria-invalid', 'false');
    await actor.click(lens().getByRole('button', { name: 'Add destination' }));

    const target = lens().getByLabelText('Channel ID');
    expect(target).toHaveFocus();
    expect(target).toHaveAttribute('aria-invalid', 'true');
    await actor.type(target, 'general');
    await actor.tab();
    expect(target).toHaveAccessibleDescription(
      expect.stringContaining('Channel IDs start with C, G or D'),
    );
    await actor.clear(target);
    await actor.type(target, '#C0123456789');
    expect(target).toHaveAttribute('aria-invalid', 'false');
    expect(
      lens().getByRole('link', { name: 'New Slack connection' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/connections?add=slack`);
  });

  it('creates with an exact uncertain retry and no credentials in the command', async () => {
    const requests: { key: string | null; body: unknown }[] = [];
    let created = false;
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      destinationsOf(() => (created ? [destination()] : [])),
      http.post(destinationsUrl, async ({ request }) => {
        requests.push({
          key: request.headers.get('idempotency-key'),
          body: await request.json(),
        });
        if (requests.length === 1) return HttpResponse.error();
        created = true;
        return HttpResponse.json(destination(), { status: 201 });
      }),
    );

    renderApp(`/w/${workspaceId}/alerts`, { strict: true });
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Add destination' }),
    );
    await chooseConnection(actor);
    await actor.type(lens().getByLabelText('Channel ID'), 'C0123456789');
    await actor.click(lens().getByRole('button', { name: 'Add destination' }));
    expect(await lens().findByRole('alert')).toHaveTextContent(
      'We couldn’t confirm whether the destination was added',
    );
    await actor.click(lens().getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByText(
        'Alerts now go to #C0123456789 via Incident Slack',
      ),
    ).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]?.body).toEqual({
      kind: 'slack',
      connectionId,
      channelId: 'C0123456789',
    });
    expect(JSON.stringify(requests)).not.toContain('xoxb-');
  });

  it('saves a new version on top of the version the lens opened with', async () => {
    let current = destination();
    let submitted: { key: string | null; body: unknown } | undefined;
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      destinationsOf(() => [current]),
      http.post(
        `${destinationsUrl}/${destinationId}/versions`,
        async ({ request }) => {
          submitted = {
            key: request.headers.get('idempotency-key'),
            body: await request.json(),
          };
          return HttpResponse.json(destination('C9876543210', 3));
        },
      ),
    );

    const { queryClient } = renderApp(`/w/${workspaceId}/alerts`);
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: /^Edit #C0123456789/u }),
    );
    expect(
      lens().getByText(/Version 1 · saving creates version 2/u),
    ).toBeInTheDocument();
    current = destination('C0000000002', 2);
    await queryClient.invalidateQueries();
    await screen.findByText('#C0000000002 via Incident Slack');
    const channel = lens().getByLabelText('Channel ID');
    await actor.clear(channel);
    await actor.type(channel, 'C9876543210');
    await actor.click(lens().getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(submitted?.body).toEqual({
        expectedVersion: 1,
        config: { kind: 'slack', connectionId, channelId: 'C9876543210' },
      });
    });
    expect(submitted?.key).toBeTruthy();
  });

  it('retries the exact version command after a lost response and refetch', async () => {
    let current = destination();
    const commands: { key: string | null; body: unknown }[] = [];
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      destinationsOf(() => [current]),
      http.post(
        `${destinationsUrl}/${destinationId}/versions`,
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

    const { queryClient } = renderApp(`/w/${workspaceId}/alerts`, {
      strict: true,
    });
    const actor = userEvent.setup();
    await actor.click(await screen.findByRole('button', { name: /^Edit/u }));
    const channel = lens().getByLabelText('Channel ID');
    await actor.clear(channel);
    await actor.type(channel, 'C9876543210');
    await actor.click(lens().getByRole('button', { name: 'Save changes' }));
    await lens().findByRole('button', { name: 'Try again' });
    await queryClient.invalidateQueries();
    await actor.click(lens().getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByText(
        'Saved alerts to #C9876543210 via Incident Slack',
      ),
    ).toBeVisible();
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[0]?.body).toEqual({
      expectedVersion: 1,
      config: { kind: 'slack', connectionId, channelId: 'C9876543210' },
    });
  });

  it('keeps edits through a version conflict and saves on top of the latest version', async () => {
    let current = destination();
    const commands: { key: string | null; body: unknown }[] = [];
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      destinationsOf(() => [current]),
      http.post(
        `${destinationsUrl}/${destinationId}/versions`,
        async ({ request }) => {
          commands.push({
            key: request.headers.get('idempotency-key'),
            body: await request.json(),
          });
          if (commands.length === 1) {
            current = destination('C0000000002', 2);
            return problem(409, 'connection.conflict');
          }
          return HttpResponse.json(destination('C9876543210', 3));
        },
      ),
    );

    renderApp(`/w/${workspaceId}/alerts`);
    const actor = userEvent.setup();
    await actor.click(await screen.findByRole('button', { name: /^Edit/u }));
    const channel = lens().getByLabelText('Channel ID');
    await actor.clear(channel);
    await actor.type(channel, 'C9876543210');
    await actor.click(lens().getByRole('button', { name: 'Save changes' }));
    expect(await lens().findByRole('alert')).toHaveTextContent(
      'Someone changed this destination while you were editing',
    );
    await actor.click(
      lens().getByRole('button', { name: 'Load latest version' }),
    );
    expect(channel).toHaveValue('C9876543210');
    await waitFor(() => {
      expect(lens().queryByRole('alert')).not.toBeInTheDocument();
    });
    await actor.click(lens().getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(commands).toHaveLength(2);
    });
    expect(commands[1]?.body).toEqual({
      expectedVersion: 2,
      config: { kind: 'slack', connectionId, channelId: 'C9876543210' },
    });
    expect(commands[1]?.key).not.toBe(commands[0]?.key);
  });

  it('repeats an unconfirmed switch change with the same key', async () => {
    const keys: (string | null)[] = [];
    let status: 'enabled' | 'disabled' = 'enabled';
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      destinationsOf(() => [destination('C0123456789', 1, status)]),
      http.put(
        `${destinationsUrl}/${destinationId}/status`,
        async ({ request }) => {
          keys.push(request.headers.get('idempotency-key'));
          expect(await request.json()).toEqual({ status: 'disabled' });
          status = 'disabled';
          if (keys.length === 1) return HttpResponse.error();
          return HttpResponse.json(destination('C0123456789', 1, 'disabled'));
        },
      ),
    );

    renderApp(`/w/${workspaceId}/alerts`, { strict: true });
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('switch', { name: /Send alerts/u }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We couldn’t confirm whether these alerts turned off',
    );
    await actor.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByText(
        'Alerts to #C0123456789 via Incident Slack turned off',
      ),
    ).toBeVisible();
    await waitFor(() => {
      expect(
        screen.getByRole('switch', { name: /Send alerts/u }),
      ).not.toBeChecked();
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('keeps a dirty lens through a failed background refresh', async () => {
    let refreshFails = false;
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      http.get(destinationsUrl, () =>
        refreshFails
          ? problem(500, 'internal.unexpected')
          : HttpResponse.json({ items: [destination()] }),
      ),
    );
    const { queryClient } = renderApp(`/w/${workspaceId}/alerts`);
    const actor = userEvent.setup();
    await actor.click(await screen.findByRole('button', { name: /^Edit/u }));
    const channel = lens().getByLabelText('Channel ID');
    await actor.clear(channel);
    await actor.type(channel, 'C9999999999');

    refreshFails = true;
    await queryClient.invalidateQueries();
    expect(
      await lens().findByText(/Couldn’t refresh.*Your edits here are kept/u),
    ).toBeVisible();
    expect(channel).toHaveValue('C9999999999');

    refreshFails = false;
    await actor.click(lens().getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(
        lens().queryByText(/Couldn’t refresh.*Your edits here are kept/u),
      ).not.toBeInTheDocument();
    });
    expect(channel).toHaveValue('C9999999999');
  });

  it('hides destination data and actions for a nondisclosing unavailable collection', async () => {
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      http.get(destinationsUrl, () => problem(404, 'resource.not_found')),
    );
    renderApp(`/w/${workspaceId}/alerts`);
    expect(
      await screen.findByRole('heading', { name: 'Alerts are unavailable' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Add destination' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/C0123456789/u)).not.toBeInTheDocument();
  });

  it('does not load the page without workflow update access', async () => {
    let destinationReads = 0;
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        capabilities: ['workspace:read', 'connection:read'],
      }),
      http.get(destinationsUrl, () => {
        destinationReads += 1;
        return HttpResponse.json({ items: [] });
      }),
    );

    renderApp(`/w/${workspaceId}/alerts`);
    expect(
      await screen.findByRole('heading', { name: 'Alerts are unavailable' }),
    ).toBeVisible();
    expect(destinationReads).toBe(0);
  });
});
