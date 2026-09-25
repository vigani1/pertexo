import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  api,
  installQueries,
  schedule,
  scheduleId,
  secondWebhook,
  secondWebhookId,
  secondWorkflowId,
  summary,
  userId,
  webhook,
  webhookId,
  workflowApi,
  workflowId,
  workspaceId,
} from './workflow-settings.fixtures';

const triggersPath = `/w/${workspaceId}/workflows/${workflowId}/triggers`;
const schedulesKey = [
  'identity',
  userId,
  'workspace',
  workspaceId,
  'workflow',
  workflowId,
  'settings',
  'schedules',
] as const;

async function acknowledgeCredentials(event: UserEvent) {
  const dialog = await screen.findByRole('dialog', { name: 'Store these now' });
  const done = within(dialog).getByRole('button', { name: 'Done' });
  expect(done).toBeDisabled();
  await event.click(
    within(dialog).getByRole('switch', { name: 'I’ve stored these' }),
  );
  await event.click(done);
}

describe('workflow triggers tab', () => {
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
    expect(screen.getByText(`/hooks/${'e'.repeat(43)}`)).toBeVisible();
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

  it('resets state and fences late credentials when the workflow changes', async () => {
    installQueries();
    let releaseCredentials: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseCredentials = resolve;
    });
    const secondApi = `${api}/workflows/${secondWorkflowId}`;
    mockServer.use(
      http.get(secondApi, () =>
        HttpResponse.json({
          workflow: {
            ...summary,
            id: secondWorkflowId,
            publishedVersionId: null,
          },
        }),
      ),
      http.get(`${secondApi}/versions`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get(`${secondApi}/triggers/schedules`, () =>
        HttpResponse.json({ items: [] }),
      ),
      http.get(`${secondApi}/triggers`, () => HttpResponse.json({ items: [] })),
      http.post(
        `${workflowApi}/triggers/${webhookId}/webhook/provision`,
        async () => {
          await blocked;
          return HttpResponse.json({
            trigger: { ...webhook, endpointReady: true, status: 'active' },
            replayed: false,
            endpointKey: 'late-endpoint-key'.padEnd(43, 'e'),
            signingSecret: 'late-signing-secret'.padEnd(43, 's'),
          });
        },
      ),
    );
    const { router } = renderApp(triggersPath);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Create endpoint' }),
    );
    await router.navigate({
      to: '/w/$workspaceId/workflows/$workflowId/triggers',
      params: { workspaceId, workflowId: secondWorkflowId },
    });
    releaseCredentials?.();
    expect(
      await screen.findByRole('heading', { name: 'Nothing is published yet' }),
    ).toBeVisible();
    expect(
      screen.queryByText('late-signing-secret'.padEnd(43, 's')),
    ).not.toBeInTheDocument();
  });
});
