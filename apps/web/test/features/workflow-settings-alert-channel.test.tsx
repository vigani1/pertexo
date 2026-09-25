import { HttpResponse, http } from 'msw';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { describeDestination } from '@/features/workflow-settings/model/destination-label';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import { slackChannelLookup, slackConnection } from '../support/slack-channels';
import {
  api,
  connectionId,
  destination,
  installQueries,
  workflowApi,
  workflowId,
  workspaceId,
} from './workflow-settings.fixtures';

const settingsPath = `/w/${workspaceId}/workflows/${workflowId}/settings`;

function slackDestination(id: string, channelId: string) {
  return {
    ...destination,
    id,
    kind: 'slack' as const,
    config: { kind: 'slack' as const, connectionId, channelId },
  };
}

const opsAlerts = slackDestination(
  '77777777-7777-4777-8777-777777777777',
  'C0123456789',
);
const privateRoom = slackDestination(
  '88888888-8888-4888-8888-888888888888',
  'G0404',
);

function installSlackAlerts(
  current: ReturnType<typeof slackDestination>,
  capabilities: readonly string[],
  lookups: string[] = [],
) {
  installQueries(capabilities);
  mockServer.use(
    http.get(`${api}/failure-notification-destinations`, () =>
      HttpResponse.json({ items: [opsAlerts, privateRoom] }),
    ),
    http.get(`${workflowApi}/failure-notification-policy`, () =>
      HttpResponse.json({ destination: current }),
    ),
    http.get(`${api}/connections`, () =>
      HttpResponse.json({
        items: [slackConnection(workspaceId, connectionId)],
        nextCursor: null,
      }),
    ),
    slackChannelLookup(
      api,
      {
        C0123456789: { name: 'ops-alerts' },
        G0404: { reason: 'missing_scope' },
      },
      lookups,
    ),
  );
}

const withLookups = ['workflow:update', 'connection:read', 'connection:use'];

describe('Slack channel names in failure alerts', { timeout: 30_000 }, () => {
  it('names a destination by channel once its name is known', () => {
    const names = new Map([
      [
        `${connectionId}:C0123456789`,
        { status: 'resolved', name: 'ops-alerts' } as const,
      ],
    ]);
    const connections = new Map([[connectionId, 'Ops bot']]);
    expect(describeDestination(opsAlerts, connections, names)).toBe(
      '#ops-alerts via Ops bot',
    );
    expect(describeDestination(privateRoom, connections, names)).toBe(
      'Slack channel G0404 via Ops bot',
    );
  });

  it('shows “#channel-name via Connection” for the current destination and the choices', async () => {
    const lookups: string[] = [];
    installSlackAlerts(opsAlerts, withLookups, lookups);
    renderApp(settingsPath);
    const event = userEvent.setup();
    const alerts = await screen.findByRole('region', {
      name: 'Failure alerts',
    });
    const now = await within(alerts).findByText('#ops-alerts via Ops bot');
    expect(now.parentElement).toHaveTextContent(
      'Failures go to#ops-alerts via Ops bot',
    );
    await event.click(
      within(alerts).getByRole('combobox', { name: 'Send failure alerts to' }),
    );
    expect(
      await screen.findByRole('option', { name: '#ops-alerts via Ops bot' }),
    ).toBeVisible();
    expect(
      screen.getByRole('option', { name: 'Slack channel G0404 via Ops bot' }),
    ).toBeVisible();
    // One bounded lookup for the connection's channels.
    expect(lookups).toEqual(['C0123456789,G0404']);
  });

  it('keeps the channel ID and says why when the name can’t be read', async () => {
    installSlackAlerts(privateRoom, withLookups);
    renderApp(settingsPath);
    const alerts = await screen.findByRole('region', {
      name: 'Failure alerts',
    });
    expect(
      await within(alerts).findByText(
        /Showing the channel ID\. The Slack app needs the channels:read scope/u,
      ),
    ).toBeVisible();
    expect(
      within(alerts).getByText('Slack channel G0404 via Ops bot'),
    ).toBeVisible();
  });

  it('doesn’t look names up for a role that can’t use connections', async () => {
    const lookups: string[] = [];
    installSlackAlerts(
      opsAlerts,
      ['workflow:update', 'connection:read'],
      lookups,
    );
    renderApp(settingsPath);
    const alerts = await screen.findByRole('region', {
      name: 'Failure alerts',
    });
    expect(
      await within(alerts).findByText('Slack channel C0123456789 via Ops bot'),
    ).toBeVisible();
    expect(lookups).toEqual([]);
  });
});
