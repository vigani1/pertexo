import { NotificationsProvider } from '@/components/ui/toast';

import { ConcurrencySection } from '@/features/workflow-settings/components/settings/concurrency-section';

import { concurrencyQueryOptions } from '@/features/workflow-settings/data/concurrency.queries';

import { useConcurrencyCommand } from '@/features/workflow-settings/data/mutations/use-concurrency-command';

import { createApiClient } from '@/lib/api/client';

import { ApiError } from '@/lib/api/error';

import type { WorkflowConcurrencySettings } from '@pertexo/contracts';

import { accessibleWorkspaceSchema } from '@pertexo/contracts';

import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';

import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import type { ReactNode } from 'react';

import { describe, expect, it } from 'vitest';

import { defaultConcurrencySettings } from '../../support/fixtures/concurrency';

import { mockServer } from '../../support/mock-server';

import { renderApp, testFetch } from '../../support/render-app';

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
  it.each([
    { status: 401, readKind: 'http' },
    { status: 403, readKind: 'http' },
    { status: 404, readKind: 'http' },
    { status: 401, readKind: 'cancellation-ignoring' },
    { status: 403, readKind: 'cancellation-ignoring' },
    { status: 404, readKind: 'cancellation-ignoring' },
  ])(
    'does not revive a snapshot from a held GET after PUT $status using a $readKind read',
    async ({ status, readKind }) => {
      const cache = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const apiClient = createApiClient({
        fetch: testFetch,
        readCsrfToken: () => 'concurrency-race-csrf',
      });
      const query = concurrencyQueryOptions(
        apiClient,
        userId,
        workspaceId,
        workflowId,
      );
      const oldSettings = { ...defaultConcurrencySettings, limit: 7 };
      cache.setQueryData(query.queryKey, oldSettings);
      let releaseOldRead: (
        settings: WorkflowConcurrencySettings,
      ) => void = () => {
        throw new Error('Old read has not started');
      };
      const oldRead = new Promise<WorkflowConcurrencySettings>((resolve) => {
        releaseOldRead = resolve;
      });
      let reads = 0;
      let authorized = false;
      const wrapper = ({ children }: Readonly<{ children: ReactNode }>) => (
        <QueryClientProvider client={cache}>{children}</QueryClientProvider>
      );
      const read = async (): Promise<WorkflowConcurrencySettings> => {
        reads += 1;
        if (reads === 1) return oldRead;
        if (!authorized)
          throw new ApiError({
            kind: 'network',
            message: 'Offline after the denial',
          });
        return { ...defaultConcurrencySettings, limit: 2, revision: 2 };
      };
      const readOptions = {
        ...query,
        refetchOnMount: false,
        // Also bypass transport cancellation: Query must fence late results itself.
        ...(readKind === 'cancellation-ignoring' ? { queryFn: read } : {}),
      };
      mockServer.use(
        http.get(endpoint, async () => {
          try {
            return HttpResponse.json(await read());
          } catch {
            return HttpResponse.error();
          }
        }),
        http.put(endpoint, () => problem(status, 'resource.not_found')),
      );
      const hook = renderHook(
        () => ({
          query: useQuery(readOptions),
          command: useConcurrencyCommand(
            apiClient,
            userId,
            workspaceId,
            workflowId,
          ),
        }),
        { wrapper },
      );
      let backgroundRead: Promise<void> = Promise.resolve();
      act(() => {
        backgroundRead = cache.refetchQueries({
          queryKey: query.queryKey,
          exact: true,
        });
      });
      await waitFor(() => {
        expect(reads).toBe(1);
      });
      let command: Promise<boolean> = Promise.resolve(true);
      act(() => {
        command = hook.result.current.command.send({
          limit: 1,
          expectedRevision: 1,
        });
      });
      await waitFor(() => {
        expect(cache.getQueryData(query.queryKey)).toBeUndefined();
      });
      await act(async () => {
        releaseOldRead(oldSettings);
        await backgroundRead;
        expect(await command).toBe(false);
      });
      expect(cache.getQueryData(query.queryKey)).toBeUndefined();
      expect(reads).toBe(2);
      hook.unmount();
      const remounted = renderHook(
        () => useQuery({ ...readOptions, refetchOnMount: 'always' as const }),
        { wrapper },
      );
      await waitFor(() => {
        expect(remounted.result.current.isError).toBe(true);
      });
      expect(remounted.result.current.data).toBeUndefined();
      expect(cache.getQueryData(query.queryKey)).toBeUndefined();
      authorized = true;
      await act(async () => {
        await cache.refetchQueries({ queryKey: query.queryKey, exact: true });
      });
      await waitFor(() => {
        expect(remounted.result.current.data).toMatchObject({
          limit: 2,
          revision: 2,
        });
      });
      remounted.unmount();
      cache.clear();
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
      renderApp(path);
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
  it('does not adopt a refreshed revision from malformed typed conflict details', async () => {
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
    renderApp(path);
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
      expectedRevision: 1,
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
    renderApp(path);
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
