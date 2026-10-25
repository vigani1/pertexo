import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

import {
  connection,
  connectionHandler,
  connectionId,
  destination,
  destinationId,
  destinationsOf,
  destinationsUrl,
  identityHandlers,
  lens,
  problem,
  timestamp,
  workspace,
  workspaceId,
} from './fixture';

describe('alert destinations', () => {
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

describe('alert destination test threads', () => {
  it('discloses the real message, pins the version, and ties a knot after acceptance', async () => {
    const actor = userEvent.setup();
    let posted: unknown;
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      destinationsOf(() => [destination()]),
      http.post(
        `${destinationsUrl}/${destinationId}/test`,
        async ({ request }) => {
          posted = await request.json();
          return HttpResponse.json({
            connection: {
              ...connection,
              health: {
                lastTestedAt: timestamp,
                lastHealthyAt: timestamp,
                lastErrorCode: null,
              },
            },
            outcome: { ok: true, httpStatus: 200, errorCode: null },
          });
        },
      ),
    );
    renderApp(`/w/${workspaceId}/alerts`);
    await actor.click(
      await screen.findByRole('button', { name: /Send test to/u }),
    );
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'one real test message',
    );
    expect(posted).toBeUndefined();
    await actor.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Send test',
      }),
    );
    expect(
      await screen.findByText('The service accepted the test message.'),
    ).toBeVisible();
    expect(posted).toEqual({
      expectedVersion: 1,
      sideEffectDisclosureAccepted: true,
    });
    expect(document.querySelector('[data-slot="test-thread"]')).toHaveAttribute(
      'data-phase',
      'ok',
    );
  });
  it('explains missing server encryption without suggesting lost owner access', async () => {
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      http.get(destinationsUrl, () =>
        problem(503, 'connection.not_configured'),
      ),
    );
    renderApp(`/w/${workspaceId}/alerts`);
    expect(
      await screen.findByText('Connections need server configuration'),
    ).toBeVisible();
    expect(
      screen.getByText(/no connection encryption provider configured/u),
    ).toBeVisible();
    expect(screen.queryByText(/don’t have access/u)).not.toBeInTheDocument();
  });
  it('checks an unconfirmed send with the same key and keeps the outcome uncertain', async () => {
    const actor = userEvent.setup();
    const keys: (string | null)[] = [];
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      destinationsOf(() => [destination()]),
      http.post(`${destinationsUrl}/${destinationId}/test`, ({ request }) => {
        keys.push(request.headers.get('Idempotency-Key'));
        return HttpResponse.error();
      }),
    );
    renderApp(`/w/${workspaceId}/alerts`);
    await actor.click(
      await screen.findByRole('button', { name: /Send test to/u }),
    );
    await actor.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Send test',
      }),
    );
    await actor.click(
      await screen.findByRole('button', { name: /Check test result/u }),
    );
    await waitFor(() => {
      expect(keys).toHaveLength(2);
    });
    expect(keys[1]).toBe(keys[0]);
    expect(document.querySelector('[data-slot="test-thread"]')).toHaveAttribute(
      'data-phase',
      'unsure',
    );
  });
});
