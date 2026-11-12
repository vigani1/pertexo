import { NotificationsProvider } from '@/components/ui/toast';

import { ConcurrencySection } from '@/features/workflow-settings/components/settings/concurrency-section';

import { concurrencyQueryOptions } from '@/features/workflow-settings/data/concurrency.queries';

import { createApiClient } from '@/lib/api/client';

import { accessibleWorkspaceSchema } from '@pertexo/contracts';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { render, screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { defaultConcurrencySettings } from '../../support/fixtures/concurrency';

import { mockServer } from '../../support/mock-server';

import { testFetch, renderLoadedApp } from '../../support/render-app';

import { workspaceWith } from '../workflows/list/fixtures';

import { installQueries, userId, workflowId, workspaceId } from './fixtures';

import {
  endpoint,
  limitField,
  path,
  problem,
  sentence,
} from './workflow-concurrency/fixture';

describe('workflow concurrency settings', () => {
  it.each([403, 404])(
    'preserves readable current settings after an action returns %s',
    async (status) => {
      installQueries();
      mockServer.use(
        http.put(endpoint, () => problem(status, 'resource.not_found')),
      );
      await renderLoadedApp(path);
      const event = userEvent.setup();
      await event.type(await limitField(event), '1');
      await event.click(
        screen.getByRole('button', { name: 'Save concurrency limit' }),
      );
      await screen.findByText(
        status === 403 ? /Your role doesn’t allow/u : /didn’t work/u,
      );
      expect(
        await screen.findByRole('region', { name: 'Concurrency' }),
      ).toHaveTextContent('workspace runs up to 10');
    },
  );
  it.each(['0', '11', '1.5'])(
    'rejects out-of-range or fractional limit %s before sending',
    async (value) => {
      installQueries();
      let writes = 0;
      mockServer.use(
        http.put(endpoint, () => {
          writes += 1;
          return HttpResponse.json({});
        }),
      );
      await renderLoadedApp(path);
      const event = userEvent.setup();
      await event.type(await limitField(event), value);
      await event.click(
        screen.getByRole('button', { name: 'Save concurrency limit' }),
      );
      await screen.findByText('Enter a whole number from 1 to 10.');
      expect(writes).toBe(0);
    },
  );
  it('forgets settings on a capability change and requires fresh authorized data on return', async () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const apiClient = createApiClient({
      fetch: testFetch,
      readCsrfToken: () => undefined,
    });
    const query = concurrencyQueryOptions(
      apiClient,
      userId,
      workspaceId,
      workflowId,
    );
    cache.setQueryData(query.queryKey, {
      ...defaultConcurrencySettings,
      limit: 7,
    });
    let response = () => problem(503, 'service.unavailable');
    mockServer.use(http.get(endpoint, () => response()));
    const content = (canRead: boolean) => (
      <QueryClientProvider client={cache}>
        <NotificationsProvider>
          <ConcurrencySection
            apiClient={apiClient}
            userId={userId}
            workflowId={workflowId}
            workspace={accessibleWorkspaceSchema.parse({
              ...workspaceWith([]),
              capabilities: canRead ? ['workflow:read'] : [],
            })}
          />
        </NotificationsProvider>
      </QueryClientProvider>
    );
    const view = render(content(false));
    await waitFor(() => {
      expect(cache.getQueryData(query.queryKey)).toBeUndefined();
    });
    expect(screen.queryByText(sentence('Up to'))).not.toBeInTheDocument();
    view.rerender(content(true));
    await screen.findByText(
      'The concurrency settings couldn’t be loaded. Try again.',
    );
    expect(screen.queryByText(/7 runs/u)).not.toBeInTheDocument();
    response = () =>
      HttpResponse.json({ ...defaultConcurrencySettings, limit: 2 });
    await cache.invalidateQueries({ queryKey: query.queryKey });
    await screen.findByText(
      sentence('Up to 2 runs at once. Extra events wait their turn.'),
    );
    cache.clear();
  });
  it('uses refreshed revision on a fresh confirmation without claiming malformed conflict details', async () => {
    installQueries();
    let current = defaultConcurrencySettings;
    const bodies: unknown[] = [];
    mockServer.use(
      http.get(endpoint, () => HttpResponse.json(current)),
      http.put(endpoint, async ({ request }) => {
        bodies.push(await request.json());
        current = { ...current, limit: 3, revision: 2 };
        return problem(409, 'workflow.concurrency_revision_conflict');
      }),
    );
    await renderLoadedApp(path);
    const event = userEvent.setup();
    await event.type(await limitField(event), '1');
    await event.click(
      screen.getByRole('button', { name: 'Save concurrency limit' }),
    );
    await screen.findByText(
      sentence('Up to 3 runs at once. Extra events wait their turn.'),
    );
    expect(screen.queryByText(/Your edits are kept/u)).not.toBeInTheDocument();
    await event.click(
      screen.getByRole('button', { name: 'Save concurrency limit' }),
    );
    await waitFor(() => {
      expect(bodies).toHaveLength(2);
    });
    expect(bodies[1]).toEqual({
      limit: 1,
      expectedRevision: 2,
      overflow: 'queue',
    });
  });
  it('saves a current operational limit and removes it without publishing', async () => {
    installQueries();
    let current = defaultConcurrencySettings;
    const bodies: unknown[] = [];
    mockServer.use(
      http.get(endpoint, () => HttpResponse.json(current)),
      http.put(endpoint, async ({ request }) => {
        const body = (await request.json()) as {
          limit: number | null;
          expectedRevision: number;
        };
        bodies.push(body);
        expect(request.headers.get('x-csrf-token')).toBeTruthy();
        expect(request.headers.get('idempotency-key')).toMatch(
          /^[a-f0-9-]{36}$/u,
        );
        current = {
          ...current,
          limit: body.limit,
          revision: current.revision + 1,
        };
        return HttpResponse.json({ settings: current, replayed: false });
      }),
    );
    await renderLoadedApp(path);
    const event = userEvent.setup();
    const section = await screen.findByRole('region', { name: 'Concurrency' });
    const input = await limitField(event);
    await event.type(input, '1');
    await event.click(
      within(section).getByRole('button', { name: 'Save concurrency limit' }),
    );
    await within(section).findByText(
      sentence('Up to 1 run at once. Extra events wait their turn.'),
    );
    await event.clear(await limitField(event));
    await event.click(
      within(section).getByRole('button', { name: 'Save concurrency limit' }),
    );
    await within(section).findByText(
      sentence('No limit of its own. The workspace runs up to 10 at once.'),
    );
    expect(bodies).toEqual([
      { limit: 1, expectedRevision: 1, overflow: 'queue' },
      { limit: null, expectedRevision: 2, overflow: 'queue' },
    ]);
  });
});
