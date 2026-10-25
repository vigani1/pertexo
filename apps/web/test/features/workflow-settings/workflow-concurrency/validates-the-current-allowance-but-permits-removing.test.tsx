import { concurrencyQueryOptions } from '@/features/workflow-settings/data/concurrency.queries';

import { createApiClient } from '@/lib/api/client';

import type { WorkflowConcurrencySettings } from '@pertexo/contracts';

import { QueryClient } from '@tanstack/react-query';

import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { defaultConcurrencySettings } from '../../../support/fixtures/concurrency';

import { mockServer } from '../../../support/mock-server';

import { renderApp, testFetch } from '../../../support/render-app';

import { installQueries, userId, workflowId, workspaceId } from '../fixtures';

import { endpoint, limitField, path, problem, sentence } from './fixture';

describe('workflow concurrency settings', () => {
  it('validates the current allowance, but permits removing a cap without an entitlement', async () => {
    installQueries();
    let current: WorkflowConcurrencySettings = {
      ...defaultConcurrencySettings,
      limit: 2,
      workspacePolicyState: 'unavailable',
      workspaceActiveRunLimit: null,
    };
    const bodies: unknown[] = [];
    mockServer.use(
      http.get(endpoint, () => HttpResponse.json(current)),
      http.put(endpoint, async ({ request }) => {
        bodies.push(await request.json());
        current = { ...current, limit: null, revision: 2 };
        return HttpResponse.json({ settings: current, replayed: false });
      }),
    );
    renderApp(path);
    const event = userEvent.setup();
    const input = await limitField(event);
    await event.click(
      screen.getByRole('button', { name: 'Save concurrency limit' }),
    );
    await screen.findByText(
      /An active workspace execution allowance is required/u,
    );
    expect(bodies).toHaveLength(0);
    await event.clear(input);
    await event.click(
      screen.getByRole('button', { name: 'Save concurrency limit' }),
    );
    await screen.findByText('Concurrency settings saved');
    expect(bodies).toEqual([
      { limit: null, expectedRevision: 1, overflow: 'queue' },
    ]);
  });
  it('retains edits after typed conflict and only resubmits after reviewing fresh authority', async () => {
    installQueries();
    let current = defaultConcurrencySettings;
    const bodies: unknown[] = [];
    mockServer.use(
      http.get(endpoint, () => HttpResponse.json(current)),
      http.put(endpoint, async ({ request }) => {
        bodies.push(await request.json());
        if (bodies.length === 1) {
          current = { ...current, limit: 3, revision: 2 };
          return problem(409, 'workflow.concurrency_revision_conflict', {
            currentRevision: 2,
          });
        }
        current = { ...current, limit: 1, revision: 3 };
        return HttpResponse.json({ settings: current, replayed: false });
      }),
    );
    renderApp(path);
    const event = userEvent.setup();
    const input = await limitField(event);
    await event.type(input, '1');
    await event.click(
      screen.getByRole('button', { name: 'Save concurrency limit' }),
    );
    await screen.findByText(/Your edits are kept/u);
    await screen.findByText(
      sentence('Up to 3 runs at once. Extra events wait their turn.'),
    );
    expect(input).toHaveValue('1');
    expect(bodies).toHaveLength(1);
    await event.click(
      screen.getByRole('button', { name: 'Save concurrency limit' }),
    );
    await screen.findByText('Concurrency settings saved');
    expect(bodies[1]).toEqual({
      limit: 1,
      expectedRevision: 2,
      overflow: 'queue',
    });
  });
  it('retries the exact body and key after an uncertain outcome, not the refreshed revision', async () => {
    installQueries();
    let current = defaultConcurrencySettings;
    const requests: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.get(endpoint, () => HttpResponse.json(current)),
      http.put(endpoint, async ({ request }) => {
        requests.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        current = { ...current, limit: 1, revision: 2 };
        return requests.length === 1
          ? HttpResponse.error()
          : HttpResponse.json({ settings: current, replayed: true });
      }),
    );
    renderApp(path);
    const event = userEvent.setup();
    await event.type(await limitField(event), '1');
    await event.click(
      screen.getByRole('button', { name: 'Save concurrency limit' }),
    );
    await event.click(
      await screen.findByRole('button', { name: 'Retry same change' }),
    );
    await screen.findByText('Concurrency settings saved');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[1]?.body).toEqual({
      limit: 1,
      expectedRevision: 1,
      overflow: 'queue',
    });
  });
  it('allows reading policy and history without rendering editing controls', async () => {
    installQueries([]);
    renderApp(path);
    const section = await screen.findByRole('region', { name: 'Concurrency' });
    await within(section).findByText(
      sentence('No limit of its own. The workspace runs up to 10 at once.'),
    );
    expect(within(section).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(section).queryByRole('combobox')).not.toBeInTheDocument();
    expect(
      within(section).getByRole('region', { name: 'Recent skipped triggers' }),
    ).toBeVisible();
  });
  it.each([401, 403, 404, 409])(
    'forgets denied snapshots durably after %i, including inactive cache reuse',
    async (status) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const options = concurrencyQueryOptions(
        createApiClient({ fetch: testFetch, readCsrfToken: () => undefined }),
        userId,
        workspaceId,
        workflowId,
      );
      let response = () =>
        HttpResponse.json({ ...defaultConcurrencySettings, limit: 7 });
      mockServer.use(http.get(endpoint, () => response()));
      await client.query(options);
      expect(client.getQueryData(options.queryKey)).toMatchObject({ limit: 7 });
      response = () =>
        problem(
          status,
          status === 409 ? 'workspace.unavailable' : 'resource.not_found',
        );
      await expect(client.query(options)).rejects.toBeDefined();
      expect(client.getQueryData(options.queryKey)).toBeUndefined();
      response = () => problem(503, 'service.unavailable');
      await expect(client.query({ ...options })).rejects.toBeDefined();
      expect(client.getQueryData(options.queryKey)).toBeUndefined();
      response = () =>
        HttpResponse.json({ ...defaultConcurrencySettings, limit: 2 });
      await client.query(options);
      expect(client.getQueryData(options.queryKey)).toMatchObject({ limit: 2 });
      client.clear();
    },
  );
  it('preserves ordinary transient-error stale display without a preceding denial', async () => {
    installQueries();
    let response = () =>
      HttpResponse.json({ ...defaultConcurrencySettings, limit: 7 });
    mockServer.use(http.get(endpoint, () => response()));
    const app = renderApp(path);
    await screen.findByText(
      sentence('Up to 7 runs at once. Extra events wait their turn.'),
    );
    response = () => problem(503, 'service.unavailable');
    await app.queryClient.invalidateQueries({
      queryKey: concurrencyQueryOptions(
        app.apiClient,
        userId,
        workspaceId,
        workflowId,
      ).queryKey,
    });
    await waitFor(() =>
      expect(
        screen.getByText(
          sentence('Up to 7 runs at once. Extra events wait their turn.'),
        ),
      ).toBeVisible(),
    );
    await screen.findByText(/Couldn’t refresh/u);
  });
});

it('saves Skip with the workflow limit and shows metadata-only skip history', async () => {
  installQueries();
  let current: WorkflowConcurrencySettings = {
    ...defaultConcurrencySettings,
    limit: 1,
  };
  mockServer.use(
    http.get(endpoint, () => HttpResponse.json(current)),
    http.put(endpoint, async ({ request }) => {
      const body = await request.json();
      expect(body).toEqual({ limit: 1, overflow: 'skip', expectedRevision: 1 });
      current = {
        ...current,
        overflow: 'skip',
        revision: 2,
        recentSkips: [
          {
            id: workflowId,
            at: defaultConcurrencySettings.asOf,
            triggerType: 'webhook',
            reason: 'concurrency_limit',
          },
        ],
      };
      return HttpResponse.json({ settings: current, replayed: false });
    }),
  );
  renderApp(path);
  const user = userEvent.setup();
  await limitField(user);
  await user.click(
    await screen.findByRole('combobox', { name: 'When the limit is reached' }),
  );
  await user.click(await screen.findByRole('option', { name: 'Skip' }));
  await user.click(
    screen.getByRole('button', { name: 'Save concurrency limit' }),
  );
  expect(await screen.findByText('Webhook skipped')).toBeVisible();
  expect(
    screen.getByText('Concurrency limit reached. No run started.'),
  ).toBeVisible();
  expect(
    screen.getByText(
      sentence(
        'Up to 1 run at once. Extra trigger events are skipped; manual starts are refused.',
      ),
    ),
  ).toBeVisible();
});
