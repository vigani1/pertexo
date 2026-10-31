import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { coldStart } from '../../support/fixtures/run';

import { mockServer } from '../../support/mock-server';

import { renderApp } from '../../support/render-app';

import {
  installQueries,
  problem,
  secondWebhook,
  secondWebhookId,
  webhook,
  webhookId,
  workflowApi,
} from './fixtures';

import { acknowledgeCredentials, triggersPath } from './triggers/fixture';

describe('workflow triggers tab', () => {
  it('explains server-disabled webhooks without suggesting a role change and keeps schedules usable', async () => {
    installQueries();
    mockServer.use(
      http.get(`${workflowApi}/triggers`, () =>
        problem(503, 'webhook.not_configured'),
      ),
    );
    renderApp(triggersPath);
    expect(
      await screen.findByText(
        /Webhooks are unavailable on this server/u,
        {},
        coldStart,
      ),
    ).toBeVisible();
    expect(screen.queryByText(/role changed/u)).not.toBeInTheDocument();
    expect(
      await screen.findByRole('article', { name: 'Schedule: Nightly check' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Create endpoint' }),
    ).not.toBeInTheDocument();
  });
  it('validates authentication settings inline and reveals a rotated header credential once', async () => {
    installQueries();
    const current = {
      ...webhook,
      endpointReady: true,
      status: 'active',
      authentication: { mode: 'signed' as const, allowedOrigins: [] },
    };
    const bodies: unknown[] = [];
    mockServer.use(
      http.get(`${workflowApi}/triggers`, () =>
        HttpResponse.json({ items: [current] }),
      ),
      http.post(
        `${workflowApi}/triggers/${webhookId}/webhook/authentication`,
        async ({ request }) => {
          const authentication = await request.json();
          bodies.push(authentication);
          return HttpResponse.json({
            trigger: { ...current, authentication },
            replayed: false,
            endpointKey: 'e'.repeat(43),
            signingSecret: 's'.repeat(43),
          });
        },
      ),
    );
    renderApp(triggersPath);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Authentication…' }),
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Webhook authentication',
    });
    await event.click(within(dialog).getByLabelText('Authentication mode'));
    await event.click(
      await screen.findByRole('option', { name: 'Header secret' }),
    );
    const header = await within(dialog).findByLabelText('Secret header');
    await event.clear(header);
    await event.type(header, 'x-forwarded-for');
    await event.click(
      within(dialog).getByRole('button', {
        name: 'Save and rotate credentials',
      }),
    );
    expect(header).toHaveFocus();
    expect(bodies).toHaveLength(0);
    await event.clear(header);
    await event.type(header, 'x-webhook-secret');
    await event.click(
      within(dialog).getByRole('button', {
        name: 'Save and rotate credentials',
      }),
    );
    expect(
      within(
        await screen.findByRole('dialog', { name: 'Store these now' }),
      ).getByText('Header secret', { exact: true }),
    ).toBeVisible();
    expect(bodies).toEqual([
      {
        mode: 'header_secret',
        headerName: 'x-webhook-secret',
        allowedOrigins: [],
      },
    ]);
    await acknowledgeCredentials(event);
  });
  it('names triggers by their step and describes schedules in words', async () => {
    installQueries();
    renderApp(triggersPath);
    const hook = await screen.findByRole('article', {
      name: 'Webhook: Receive order',
    });
    expect(within(hook).getByText('Needs setup')).toBeVisible();
    expect(within(hook).getByText(/No endpoint yet/u)).toBeVisible();
    expect(
      within(hook).getByText('How to send events to this webhook'),
    ).toBeVisible();
    expect(
      await within(hook).findByText(/Create an endpoint, and each request/u),
    ).toBeVisible();
    const timer = screen.getByRole('article', {
      name: 'Schedule: Nightly check',
    });
    expect(within(timer).getByText('Every 15 minutes')).toBeVisible();
    expect(within(timer).getByText('Healthy')).toBeVisible();
    expect(
      within(timer).getByText(/it’s skipped and the next one runs on time/u),
    ).toBeVisible();
    expect(within(timer).getByText('Not yet')).toBeVisible();
    expect(
      within(timer).getByRole('switch', { name: 'Schedule on' }),
    ).toBeChecked();
    expect(screen.queryByText(/webhook-node/u)).not.toBeInTheDocument();
  });
  it('creates an endpoint and shows its credentials once, until they are stored', async () => {
    const keys: (string | null)[] = [];
    installQueries();
    mockServer.use(
      http.post(
        `${workflowApi}/triggers/${webhookId}/webhook/provision`,
        ({ request }) => {
          keys.push(request.headers.get('idempotency-key'));
          return HttpResponse.json({
            trigger: { ...webhook, endpointReady: true, status: 'active' },
            replayed: false,
            endpointKey: 'e'.repeat(43),
            signingSecret: 's'.repeat(43),
          });
        },
      ),
    );
    renderApp(triggersPath);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Create endpoint' }),
    );
    expect(await screen.findByText('e'.repeat(43))).toBeVisible();
    expect(screen.getByText('s'.repeat(43))).toBeVisible();
    expect(
      screen.getByText(`http://localhost:3000/hooks/${'e'.repeat(43)}`),
    ).toBeVisible();
    await acknowledgeCredentials(event);
    await waitFor(() => {
      expect(screen.queryByText('s'.repeat(43))).not.toBeInTheDocument();
    });
    expect(await screen.findByText('Endpoint created')).toBeVisible();
    expect(keys).toEqual([expect.any(String)]);
  });
  it('serializes webhook credentials until the current result is acknowledged', async () => {
    installQueries();
    let firstCalls = 0;
    let secondCalls = 0;
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mockServer.use(
      http.get(`${workflowApi}/triggers`, () =>
        HttpResponse.json({ items: [webhook, secondWebhook] }),
      ),
      http.post(
        `${workflowApi}/triggers/${webhookId}/webhook/provision`,
        async () => {
          firstCalls += 1;
          await firstPending;
          return HttpResponse.json({
            trigger: { ...webhook, endpointReady: true, status: 'active' },
            replayed: false,
            endpointKey: 'first-endpoint-key'.padEnd(43, 'e'),
            signingSecret: 'first-signing-secret'.padEnd(43, 's'),
          });
        },
      ),
      http.post(
        `${workflowApi}/triggers/${secondWebhookId}/webhook/provision`,
        () => {
          secondCalls += 1;
          return HttpResponse.json({
            trigger: {
              ...secondWebhook,
              endpointReady: true,
              status: 'active',
            },
            replayed: false,
            endpointKey: 'second-endpoint-key'.padEnd(43, 'e'),
            signingSecret: 'second-signing-secret'.padEnd(43, 's'),
          });
        },
      ),
    );
    renderApp(triggersPath);
    const event = userEvent.setup();
    const first = await screen.findByRole('article', {
      name: 'Webhook: Receive order',
    });
    const second = screen.getByRole('article', { name: 'Webhook: Webhook' });
    await event.click(
      within(first).getByRole('button', { name: 'Create endpoint' }),
    );
    await waitFor(() => {
      expect(firstCalls).toBe(1);
    });
    const secondButton = within(second).getByRole('button', {
      name: 'Create endpoint',
    });
    expect(secondButton).toBeDisabled();
    await event.click(secondButton);
    expect(secondCalls).toBe(0);

    releaseFirst?.();
    expect(
      await screen.findByText('first-signing-secret'.padEnd(43, 's')),
    ).toBeVisible();
    await acknowledgeCredentials(event);
    await waitFor(() => {
      expect(
        screen.queryByText('first-signing-secret'.padEnd(43, 's')),
      ).not.toBeInTheDocument();
    });
    await event.click(
      within(
        screen.getByRole('article', { name: 'Webhook: Webhook' }),
      ).getByRole('button', { name: 'Create endpoint' }),
    );
    expect(
      await screen.findByText('second-signing-secret'.padEnd(43, 's')),
    ).toBeVisible();
    expect(secondCalls).toBe(1);
  });
});
