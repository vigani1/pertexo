import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../support/mock-server';

import { renderApp } from '../../support/render-app';

import {
  chooseConnection,
  connectionHandler,
  connectionId,
  destination,
  destinationId,
  destinationsOf,
  destinationsUrl,
  identityHandlers,
  lens,
  problem,
  workspace,
  workspaceId,
} from './destinations/fixture';

describe('alert destinations', () => {
  it('opens the destination a link names, once it has loaded', async () => {
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      destinationsOf(() => [destination()]),
    );
    renderApp(`/w/${workspaceId}/settings/alerts?destination=${destinationId}`);
    const sheet = await screen.findByRole('dialog');
    expect(
      await within(sheet).findByRole('heading', { name: /edit/iu }),
    ).toBeVisible();
    expect(within(sheet).queryByRole('heading', { name: /add/iu })).toBeNull();
  });
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
});
