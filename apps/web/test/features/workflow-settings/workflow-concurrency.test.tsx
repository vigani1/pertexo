import { HttpResponse, http } from 'msw';
import {
  act,
  render,
  renderHook,
  screen,
  within,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { accessibleWorkspaceSchema } from '@pertexo/contracts';
import type { WorkflowConcurrencySettings } from '@pertexo/contracts';
import { createApiClient } from '@/lib/api/client';
import { concurrencyQueryOptions } from '@/features/workflow-settings/data/concurrency.queries';
import { useConcurrencyCommand } from '@/features/workflow-settings/data/mutations/use-concurrency-command';
import { ApiError } from '@/lib/api/error';
import { ConcurrencySection } from '@/features/workflow-settings/components/settings/concurrency-section';
import { NotificationsProvider } from '@/components/ui/toast';
import { mockServer } from '../../support/mock-server';
import { defaultConcurrencySettings } from '../../support/fixtures/concurrency';
import { renderApp, testFetch } from '../../support/render-app';
import {
  installQueries,
  workflowApi,
  workspaceId,
  workflowId,
  userId,
} from './fixtures';
import { workspaceWith } from '../workflows/list/fixtures';

const path = `/w/${workspaceId}/workflows/${workflowId}/settings`;
const endpoint = `${workflowApi}/concurrency`;
function problem(status: number, code: string, extras = {}) {
  return HttpResponse.json(
    {
      type: `https://api.pertexo.test/problems/${code}`,
      title: 'Concurrency request failed',
      status,
      code,
      requestId: 'concurrency-test',
      ...extras,
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

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
      await event.type(
        await screen.findByRole('textbox', { name: 'Runs at once' }),
        value,
      );
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
    expect(screen.queryByText(/Current limit/u)).not.toBeInTheDocument();
    view.rerender(content(true));
    await screen.findByText(
      'The concurrency settings couldn’t be loaded. Try again.',
    );
    expect(screen.queryByText(/7 active runs/u)).not.toBeInTheDocument();
    response = () =>
      HttpResponse.json({ ...defaultConcurrencySettings, limit: 2 });
    await cache.invalidateQueries({ queryKey: query.queryKey });
    await screen.findByText(
      'Current limit: 2 active runs. Workspace limits still apply.',
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
    await event.type(
      await screen.findByRole('textbox', { name: 'Runs at once' }),
      '1',
    );
    await event.click(
      screen.getByRole('button', { name: 'Save concurrency limit' }),
    );
    await screen.findByText(
      'Current limit: 3 active runs. Workspace limits still apply.',
    );
    expect(screen.queryByText(/Your edits are kept/u)).not.toBeInTheDocument();
    await event.click(
      screen.getByRole('button', { name: 'Save concurrency limit' }),
    );
    await waitFor(() => {
      expect(bodies).toHaveLength(2);
    });
    expect(bodies[1]).toEqual({ limit: 1, expectedRevision: 1 });
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
    const input = await within(section).findByRole('textbox', {
      name: 'Runs at once',
    });
    await event.type(input, '1');
    await event.click(
      within(section).getByRole('button', { name: 'Save concurrency limit' }),
    );
    await within(section).findByText(
      'Current limit: 1 active run. Workspace limits still apply.',
    );
    await event.clear(input);
    await event.click(
      within(section).getByRole('button', { name: 'Save concurrency limit' }),
    );
    await within(section).findByText(
      'Current limit: no additional workflow limit. Workspace limits still apply.',
    );
    expect(bodies).toEqual([
      { limit: 1, expectedRevision: 1 },
      { limit: null, expectedRevision: 2 },
    ]);
  });

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
    const input = await screen.findByRole('textbox', { name: 'Runs at once' });
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
    expect(bodies).toEqual([{ limit: null, expectedRevision: 1 }]);
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
    const input = await screen.findByRole('textbox', { name: 'Runs at once' });
    await event.type(input, '1');
    await event.click(
      screen.getByRole('button', { name: 'Save concurrency limit' }),
    );
    await screen.findByText(/Your edits are kept/u);
    await screen.findByText(
      'Current limit: 3 active runs. Workspace limits still apply.',
    );
    expect(input).toHaveValue('1');
    expect(bodies).toHaveLength(1);
    await event.click(
      screen.getByRole('button', { name: 'Save concurrency limit' }),
    );
    await screen.findByText('Concurrency settings saved');
    expect(bodies[1]).toEqual({ limit: 1, expectedRevision: 2 });
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
    await event.type(
      await screen.findByRole('textbox', { name: 'Runs at once' }),
      '1',
    );
    await event.click(
      screen.getByRole('button', { name: 'Save concurrency limit' }),
    );
    await event.click(
      await screen.findByRole('button', { name: 'Retry same change' }),
    );
    await screen.findByText('Concurrency settings saved');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[1]?.body).toEqual({ limit: 1, expectedRevision: 1 });
  });

  it('allows reading without workflow:update and never renders deferred policy controls', async () => {
    installQueries([]);
    renderApp(path);
    const section = await screen.findByRole('region', { name: 'Concurrency' });
    await within(section).findByText(
      'Current limit: no additional workflow limit. Workspace limits still apply.',
    );
    expect(within(section).queryByRole('textbox')).not.toBeInTheDocument();
    expect(
      within(section).queryByText(/skip|queue length/iu),
    ).not.toBeInTheDocument();
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
      'Current limit: 7 active runs. Workspace limits still apply.',
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
          'Current limit: 7 active runs. Workspace limits still apply.',
        ),
      ).toBeVisible(),
    );
    await screen.findByText(/Couldn’t refresh/u);
  });
});
