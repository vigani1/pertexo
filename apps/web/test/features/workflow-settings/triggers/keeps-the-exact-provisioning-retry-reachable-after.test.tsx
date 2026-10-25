import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

import {
  installQueries,
  publishedGraph,
  schedule,
  scheduleId,
  version,
  versionId,
  webhook,
  webhookId,
  workflowApi,
  workflowId,
  workspaceId,
} from '../fixtures';

import { schedulesKey, triggersPath } from './fixture';

describe('workflow triggers tab', () => {
  it('keeps the exact provisioning retry reachable after the endpoint status refreshes', async () => {
    installQueries();
    let currentWebhook = webhook;
    const provisionKeys: string[] = [];
    let rotateRequests = 0;
    mockServer.use(
      http.get(`${workflowApi}/triggers`, () =>
        HttpResponse.json({ items: [currentWebhook] }),
      ),
      http.post(
        `${workflowApi}/triggers/${webhookId}/webhook/provision`,
        ({ request }) => {
          provisionKeys.push(request.headers.get('idempotency-key') ?? '');
          currentWebhook = {
            ...webhook,
            endpointReady: true,
            status: 'active',
            healthStatus: 'healthy',
          };
          if (provisionKeys.length === 1)
            return new HttpResponse('{', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          return HttpResponse.json({ trigger: currentWebhook, replayed: true });
        },
      ),
      http.post(
        `${workflowApi}/triggers/${webhookId}/webhook/rotate-endpoint`,
        () => {
          rotateRequests += 1;
          return HttpResponse.json({});
        },
      ),
    );
    const { queryClient } = renderApp(triggersPath);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Create endpoint' }),
    );
    expect(
      await screen.findByRole('button', {
        name: 'Retry creating the endpoint',
      }),
    ).toBeVisible();
    await queryClient.refetchQueries({
      queryKey: [...schedulesKey.slice(0, -1), 'webhooks'],
    });
    expect(
      await screen.findByRole('button', { name: 'Rotate URL' }),
    ).toBeDisabled();

    await event.click(
      screen.getByRole('button', { name: 'Retry creating the endpoint' }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Retry creating the endpoint' }),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Rotate URL' })).toBeEnabled();
    expect(provisionKeys).toHaveLength(2);
    expect(provisionKeys[1]).toBe(provisionKeys[0]);
    expect(rotateRequests).toBe(0);
  });
  it('rotates the signing secret using the key inside a pasted webhook address', async () => {
    const endpointKey = 'k'.repeat(43);
    const bodies: unknown[] = [];
    installQueries();
    mockServer.use(
      http.get(`${workflowApi}/triggers`, () =>
        HttpResponse.json({
          items: [
            {
              ...webhook,
              endpointReady: true,
              status: 'active',
              healthStatus: 'healthy',
            },
          ],
        }),
      ),
      http.post(
        `${workflowApi}/triggers/${webhookId}/webhook/rotate-secret`,
        async ({ request }) => {
          bodies.push(await request.json());
          return HttpResponse.json({
            trigger: { ...webhook, endpointReady: true, status: 'active' },
            replayed: false,
            signingSecret: 'n'.repeat(43),
          });
        },
      ),
    );
    renderApp(triggersPath);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Rotate secret' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Rotate the signing secret',
    });
    const field = within(dialog).getByLabelText(
      'Current address or endpoint key',
    );
    await event.type(field, 'https://api.example.test/hooks/too-short');
    await event.click(
      within(dialog).getByRole('button', { name: 'Rotate secret' }),
    );
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(bodies).toHaveLength(0);

    await event.clear(field);
    await event.type(field, `https://api.example.test/hooks/${endpointKey}`);
    await event.click(
      within(dialog).getByRole('button', { name: 'Rotate secret' }),
    );
    expect(await screen.findByText('n'.repeat(43))).toBeVisible();
    expect(bodies).toEqual([{ endpointKey }]);
  });
  it('asks before turning a schedule off and uses a fresh key once an uncertain command is observed', async () => {
    let currentSchedule = schedule;
    const disableKeys: string[] = [];
    const enableKeys: string[] = [];
    installQueries();
    mockServer.use(
      http.get(`${workflowApi}/triggers/schedules`, () =>
        HttpResponse.json({ items: [currentSchedule] }),
      ),
      http.post(
        `${workflowApi}/triggers/${scheduleId}/schedule/disable`,
        ({ request }) => {
          disableKeys.push(request.headers.get('idempotency-key') ?? '');
          currentSchedule = {
            ...schedule,
            status: 'disabled',
            healthStatus: 'disabled',
          };
          if (disableKeys.length === 1) return HttpResponse.error();
          return HttpResponse.json({
            trigger: currentSchedule,
            replayed: false,
          });
        },
      ),
      http.post(
        `${workflowApi}/triggers/${scheduleId}/schedule/enable`,
        ({ request }) => {
          enableKeys.push(request.headers.get('idempotency-key') ?? '');
          currentSchedule = schedule;
          return HttpResponse.json({
            trigger: currentSchedule,
            replayed: false,
          });
        },
      ),
    );
    const { queryClient } = renderApp(triggersPath);
    const event = userEvent.setup();
    const toggle = () => screen.getByRole('switch', { name: 'Schedule on' });
    await event.click(
      await screen.findByRole('switch', { name: 'Schedule on' }),
    );
    const confirm = await screen.findByRole('dialog', {
      name: 'Turn off this schedule?',
    });
    expect(disableKeys).toHaveLength(0);
    await event.click(
      within(confirm).getByRole('button', { name: 'Turn off' }),
    );
    expect(
      await screen.findByText(
        /couldn’t confirm whether turning this schedule off/u,
      ),
    ).toBeVisible();

    queryClient.setQueryData(schedulesKey, { items: [currentSchedule] });
    await waitFor(() => {
      expect(toggle()).not.toBeChecked();
    });
    await event.click(toggle());
    await waitFor(() => {
      expect(enableKeys).toHaveLength(1);
    });
    expect(await screen.findByText('Schedule turned on')).toBeVisible();
    await waitFor(() => {
      expect(toggle()).toBeChecked();
    });
    await event.click(toggle());
    await event.click(
      within(
        await screen.findByRole('dialog', { name: 'Turn off this schedule?' }),
      ).getByRole('button', { name: 'Turn off' }),
    );
    await waitFor(() => {
      expect(disableKeys).toHaveLength(2);
    });
    expect(disableKeys[1]).not.toBe(disableKeys[0]);
    expect(enableKeys[0]).not.toBe(disableKeys[0]);
  });
  it('tells a viewer who sees webhooks instead of asking for them', async () => {
    installQueries(['run:read']);
    let webhookReads = 0;
    mockServer.use(
      http.get(`${workflowApi}/triggers`, () => {
        webhookReads += 1;
        return HttpResponse.json({ items: [] });
      }),
      http.get(`${workflowApi}/triggers/schedules`, () =>
        HttpResponse.json({ items: [] }),
      ),
    );
    renderApp(triggersPath);
    expect(
      await screen.findByText(
        'Webhook addresses and deliveries are shown to owners, admins and builders.',
      ),
    ).toBeVisible();
    expect(
      await screen.findByText('The published version has no Schedule step.'),
    ).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'Add one in Build' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/role changed/u)).not.toBeInTheDocument();
    expect(webhookReads).toBe(0);
  });
  it('points to Build when the published version has no trigger', async () => {
    installQueries();
    mockServer.use(
      http.get(`${workflowApi}/triggers/schedules`, () =>
        HttpResponse.json({ items: [] }),
      ),
      http.get(`${workflowApi}/triggers`, () =>
        HttpResponse.json({ items: [] }),
      ),
    );
    renderApp(triggersPath);
    const heading = await screen.findByRole('heading', {
      name: 'This version has no trigger',
    });
    expect(heading).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open Build' })).toHaveAttribute(
      'href',
      `/w/${workspaceId}/workflows/${workflowId}`,
    );
    // The empty tab starts under the hub bar without a divider or a glyph.
    const empty = heading.closest('[data-slot="empty"]');
    expect(empty).toHaveClass('border-t-0');
    expect(empty?.querySelector('[data-slot="status-glyph"]')).toBeNull();
  });
  it('shows a Form trigger instead of claiming the version has none', async () => {
    const [step] = publishedGraph.nodes;
    installQueries();
    mockServer.use(
      http.get(`${workflowApi}/triggers/schedules`, () =>
        HttpResponse.json({ items: [] }),
      ),
      http.get(`${workflowApi}/triggers`, () =>
        HttpResponse.json({ items: [] }),
      ),
      http.get(`${workflowApi}/versions`, () =>
        HttpResponse.json({
          items: [
            version(versionId, 1, {
              ...publishedGraph,
              nodes: [
                {
                  ...step,
                  id: 'form-node',
                  definition: { key: 'core.form', version: 1 },
                  label: 'Expense form',
                },
              ],
            }),
          ],
          nextCursor: null,
        }),
      ),
    );
    renderApp(triggersPath);
    const form = await screen.findByRole('region', { name: 'Form' });
    expect(
      within(form).getByText(/each time someone submits the form/u),
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'This version has no trigger' }),
    ).not.toBeInTheDocument();
  });
});
