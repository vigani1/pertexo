import type { AccessibleWorkspace } from '@pertexo/contracts';
import { HttpResponse, http } from 'msw';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
import {
  apiBase,
  coldStart,
  fixtureIds,
  fixtureStatistics,
  fixtureWorkspace,
  identityHandlers,
  statisticsHandler,
} from '../../support/fixtures/run';
import { parseUsageSearch } from '@/features/usage/search.public';
import { usageCapacityQueryOptions } from '@/features/usage/data/usage.queries';
import { createApiClient } from '@/lib/api/client';

const path = `/w/${fixtureIds.workspace}/settings/usage`;
const capabilities: AccessibleWorkspace['capabilities'] = [
  'workspace:read',
  'run:read',
  'artifact:read',
  'workflow:read',
];
const capacity = {
  asOf: '2026-09-15T10:00:00.123456Z',
  execution: {
    activeRuns: 2,
    reservedActiveSlots: 1,
    activeCapacityConsumed: 3,
    queuedRuns: 4,
    policy: {
      state: 'active',
      version: 1,
      activeRunLimit: 5,
      queuedRunLimit: 100,
    },
  },
  artifacts: {
    chargedBytes: '9007199254740993',
    byteLimit: '9223372036854775807',
    chargedCount: 2,
    artifactCountLimit: 1000,
    source: 'stored',
  },
};

function install(
  options: Readonly<{
    caps?: Readonly<AccessibleWorkspace['capabilities']>;
    state?: string;
    snapshot?: unknown;
    capacityResponse?: () => Response;
  }> = {},
) {
  let reads = 0;
  const seen: URLSearchParams[] = [];
  mockServer.use(
    ...(options.state === undefined
      ? []
      : [
          http.get('http://pertexo.test/v1/workspaces', () =>
            HttpResponse.json({
              items: [
                {
                  ...fixtureWorkspace(options.caps ?? capabilities),
                  status: options.state,
                },
              ],
              nextCursor: null,
            }),
          ),
        ]),
    ...identityHandlers(options.caps ?? capabilities),
    http.get(`${apiBase}/usage-capacity`, () => {
      reads += 1;
      return (
        options.capacityResponse?.() ??
        HttpResponse.json(options.snapshot ?? capacity)
      );
    }),
    statisticsHandler(
      (query) =>
        fixtureStatistics({
          window: query.get('window') ?? '24h',
          byStatus: { succeeded: 6, failed: 2 },
          ...(query.get('breakdown') === 'workflow'
            ? {
                workflows: [
                  {
                    workflowId: fixtureIds.workflow,
                    workflowName: 'Daily intake',
                    total: 8,
                  },
                ],
              }
            : {}),
        }),
      seen,
    ),
    http.get(`${apiBase}/runs`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
  );
  return { reads: () => reads, seen };
}

describe('workspace Usage', () => {
  it('keeps exact current capacity separate from retained activity and server-bound drilldowns', async () => {
    const { seen } = install();
    renderApp(`${path}?window=6h&ignored=secret`);
    await screen.findByRole('heading', { name: 'Usage' }, coldStart);
    const current = screen.getByRole('region', { name: 'Current capacity' });
    expect(
      await within(current).findByText('8 PB', { selector: 'span' }),
    ).toBeVisible();
    expect(current).toHaveTextContent('8 EB');
    expect(current).toHaveTextContent(
      'One more place is held for a queued run about to start.',
    );
    expect(current).toHaveTextContent(
      'Files count from upload until they’re fully deleted',
    );
    // The header shows the older of the two snapshot times.
    expect(
      document.querySelector('[data-slot="page-header-meta"] time'),
    ).toHaveAttribute('datetime', '2026-09-15T10:00:00.000000Z');
    expect(await screen.findByText('Daily intake')).toBeVisible();
    const failed = screen.getByRole('list', {
      name: 'Activity by current run status',
    });
    const link = within(failed).getByRole('link', { name: 'Failed 2' });
    const url = new URL(link.getAttribute('href') ?? '', 'http://pertexo.test');
    expect(url.searchParams.get('status')).toBe('failed');
    expect(url.searchParams.get('createdAtFrom')).toBe(
      '2026-09-14T10:00:00.000000Z',
    );
    expect(url.searchParams.get('createdAtBefore')).toBe(
      '2026-09-15T10:00:00.000000Z',
    );
    expect(
      seen.some(
        (query) =>
          query.get('window') === '6h' && query.get('breakdown') === 'workflow',
      ),
    ).toBe(true);
  });

  it('writes counts in the thousands with separators', async () => {
    install({
      snapshot: {
        ...capacity,
        artifacts: { ...capacity.artifacts, chargedCount: 1250 },
      },
    });
    mockServer.use(
      statisticsHandler((query) =>
        fixtureStatistics({
          window: query.get('window') ?? '24h',
          byStatus: { succeeded: 1881, failed: 142 },
          ...(query.get('breakdown') === 'workflow'
            ? {
                workflows: [
                  {
                    workflowId: fixtureIds.workflow,
                    workflowName: 'Daily intake',
                    total: 2023,
                  },
                ],
              }
            : {}),
        }),
      ),
    );
    renderApp(path);
    await screen.findByRole('heading', { name: 'Usage' }, coldStart);
    // "2023 runs started" in the display face reads like a year.
    expect(
      await screen.findByText('2,023', { selector: 'span.text-2xl' }),
    ).toBeVisible();
    const statuses = screen.getByRole('list', {
      name: 'Activity by current run status',
    });
    expect(
      within(statuses).getByRole('link', { name: 'Succeeded 1,881' }),
    ).toBeVisible();
    expect(
      screen.getByRole('list', { name: 'Activity by workflow' }),
    ).toHaveTextContent('Daily intake2,023');
    expect(
      screen.getByRole('region', { name: 'Current capacity' }),
    ).toHaveTextContent('1,250 / 1,000');
  });

  it('keeps the fixed window in the URL and never requests history to aggregate', async () => {
    const { seen } = install();
    const { router } = renderApp(path);
    await screen.findByText('Daily intake', {}, coldStart);
    await userEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ window: '7d' });
    });
    await waitFor(() => {
      expect(seen.some((query) => query.get('window') === '7d')).toBe(true);
    });
  });

  it.each(['suspended', 'pending_deletion'])(
    'does not read capacity in a %s workspace, while activity remains available',
    async (state) => {
      const { reads } = install({ state });
      renderApp(path);
      await screen.findByText('Daily intake', {}, coldStart);
      expect(
        screen.getByText(
          'Current capacity is available only for an active workspace.',
        ),
      ).toBeVisible();
      expect(reads()).toBe(0);
    },
  );

  it('requires the intersection for capacity, but only run read for activity', async () => {
    const { reads } = install({ caps: ['workspace:read', 'run:read'] });
    renderApp(path);
    await screen.findByText('Workflow cccc…cccc', {}, coldStart);
    expect(screen.queryByText('Daily intake')).not.toBeInTheDocument();
    expect(
      screen.getByText('You need access to runs and files to see capacity.'),
    ).toBeVisible();
    expect(reads()).toBe(0);
  });

  it('does not read either snapshot without run read', async () => {
    const { reads, seen } = install({
      caps: ['workspace:read', 'artifact:read'],
    });
    renderApp(path);
    await screen.findByText(
      'You need access to runs to see recent runs.',
      {},
      coldStart,
    );
    expect(reads()).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it('shows unavailable execution limits and actual zero storage limits distinctly', async () => {
    install({
      snapshot: {
        ...capacity,
        execution: {
          ...capacity.execution,
          policy: {
            state: 'unavailable',
            version: null,
            activeRunLimit: null,
            queuedRunLimit: null,
          },
        },
        artifacts: {
          chargedBytes: '0',
          byteLimit: '0',
          chargedCount: 0,
          artifactCountLimit: 0,
          source: 'default',
        },
      },
    });
    renderApp(path);
    await screen.findByText('unavailable', { selector: 'strong' }, coldStart);
    expect(screen.getAllByText('/ limit unavailable')).toHaveLength(2);
    expect(screen.getByText('/ 0 B')).toBeVisible();
    expect(screen.getByText('No storage capacity')).toBeVisible();
  });

  it.each(['expired', 'suspended', 'not_yet_effective'])(
    'does not describe a %s policy as unlimited or effective',
    async (state) => {
      install({
        snapshot: {
          ...capacity,
          execution: {
            ...capacity.execution,
            policy: { ...capacity.execution.policy, state },
          },
        },
      });
      renderApp(path);
      await screen.findByText(
        /New runs aren’t accepted right now/u,
        {},
        coldStart,
      );
      expect(screen.getByText('/ 5')).toBeVisible();
    },
  );

  it.each([401, 403, 404, 409])(
    'forgets capacity after %s until fresh success, including remount and later failures',
    async (denial) => {
      let status = 200;
      let fresh = false;
      install({
        capacityResponse: () =>
          status === 200
            ? HttpResponse.json(
                fresh
                  ? {
                      ...capacity,
                      artifacts: { ...capacity.artifacts, chargedBytes: '42' },
                    }
                  : capacity,
              )
            : new HttpResponse(null, { status }),
      });
      const { router } = renderApp(path);
      await screen.findByText('8 PB', { selector: 'span' }, coldStart);
      status = 503;
      await userEvent.click(
        screen.getByRole('button', { name: 'Refresh current capacity' }),
      );
      await screen.findByText(/Couldn’t refresh. Showing results/u);
      expect(screen.getByText('8 PB', { selector: 'span' })).toBeVisible();
      status = denial;
      await userEvent.click(
        screen.getByRole('button', { name: 'Refresh current capacity' }),
      );
      await waitFor(() =>
        expect(
          screen.queryByText('8 PB', { selector: 'span' }),
        ).not.toBeInTheDocument(),
      );
      expect(screen.getByText('Daily intake')).toBeVisible();
      status = 503;
      await userEvent.click(
        screen.getByRole('button', { name: 'Refresh current capacity' }),
      );
      await screen.findByText(
        'Current capacity couldn’t be loaded. Try again.',
      );
      expect(
        screen.queryByText('8 PB', { selector: 'span' }),
      ).not.toBeInTheDocument();
      await act(() =>
        router.navigate({
          to: '/w/$workspaceId/settings',
          params: { workspaceId: fixtureIds.workspace },
        }),
      );
      await act(() =>
        router.navigate({
          to: '/w/$workspaceId/settings/usage',
          params: { workspaceId: fixtureIds.workspace },
          search: { window: '24h' },
        }),
      );
      await screen.findByText(
        'Current capacity couldn’t be loaded. Try again.',
      );
      expect(
        screen.queryByText('8 PB', { selector: 'span' }),
      ).not.toBeInTheDocument();
      fresh = true;
      status = 200;
      await userEvent.click(
        screen.getByRole('button', { name: 'Refresh current capacity' }),
      );
      expect(
        await screen.findByText('42 B', { selector: 'span' }),
      ).toBeVisible();
      expect(
        screen.queryByText('8 PB', { selector: 'span' }),
      ).not.toBeInTheDocument();
    },
  );

  it.each([401, 403, 404, 409])(
    'forgets every activity window after %s and recovers only with fresh success',
    async (denial) => {
      install();
      let status = 200;
      let fresh = false;
      mockServer.use(
        http.get(`${apiBase}/run-statistics`, ({ request }) => {
          const query = new URL(request.url).searchParams;
          if (query.get('breakdown') !== 'workflow')
            return HttpResponse.json(fixtureStatistics());
          return status === 200
            ? HttpResponse.json(
                fixtureStatistics({
                  window: query.get('window') ?? '24h',
                  workflows: [
                    {
                      workflowId: fixtureIds.workflow,
                      workflowName: fresh ? 'Fresh activity' : 'Old activity',
                      total: 8,
                    },
                  ],
                }),
              )
            : new HttpResponse(null, { status });
        }),
      );
      const { router } = renderApp(path);
      await screen.findByText('Old activity', {}, coldStart);
      await userEvent.click(screen.getByRole('button', { name: '6 hours' }));
      await screen.findByText('Old activity');
      status = 503;
      await userEvent.click(
        screen.getByRole('button', { name: 'Refresh recent runs' }),
      );
      await screen.findByText(/Couldn’t refresh. Showing results/u);
      expect(screen.getByText('Old activity')).toBeVisible();
      status = denial;
      await userEvent.click(
        screen.getByRole('button', { name: 'Refresh recent runs' }),
      );
      await waitFor(() =>
        expect(screen.queryByText('Old activity')).not.toBeInTheDocument(),
      );
      status = 503;
      await userEvent.click(
        screen.getByRole('button', { name: 'Refresh recent runs' }),
      );
      await screen.findByText('Recent runs couldn’t be loaded. Try again.');
      expect(screen.queryByText('Old activity')).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: '24 hours' }));
      await screen.findByText('Recent runs couldn’t be loaded. Try again.');
      expect(screen.queryByText('Old activity')).not.toBeInTheDocument();
      await act(() =>
        router.navigate({
          to: '/w/$workspaceId/settings',
          params: { workspaceId: fixtureIds.workspace },
        }),
      );
      await act(() =>
        router.navigate({
          to: '/w/$workspaceId/settings/usage',
          params: { workspaceId: fixtureIds.workspace },
          search: { window: '6h' },
        }),
      );
      await screen.findByText('Recent runs couldn’t be loaded. Try again.');
      expect(screen.queryByText('Old activity')).not.toBeInTheDocument();
      expect(screen.getByText('8 PB', { selector: 'span' })).toBeVisible();
      status = 200;
      fresh = true;
      await userEvent.click(
        screen.getByRole('button', { name: 'Refresh recent runs' }),
      );
      expect(await screen.findByText('Fresh activity')).toBeVisible();
      expect(screen.queryByText('Old activity')).not.toBeInTheDocument();
    },
  );

  it('recovers the failed capacity panel independently', async () => {
    let failing = true;
    install({
      capacityResponse: () =>
        failing
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.json(capacity),
    });
    renderApp(path);
    await screen.findByText(
      'Current capacity couldn’t be loaded. Try again.',
      {},
      coldStart,
    );
    expect(screen.getByText('Daily intake')).toBeVisible();
    failing = false;
    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh current capacity' }),
    );
    expect(await screen.findByText('8 PB', { selector: 'span' })).toBeVisible();
  });

  it('sanitizes unsupported windows without introducing calendar ranges', () => {
    expect(parseUsageSearch({ window: '30d' })).toEqual({ window: '24h' });
    expect(parseUsageSearch({ window: '1h', timezone: 'UTC' })).toEqual({
      window: '1h',
    });
  });

  it('retains current capacity when activity fails and recovers activity independently', async () => {
    install();
    let failing = true;
    mockServer.use(
      http.get(`${apiBase}/run-statistics`, ({ request }) => {
        const query = new URL(request.url).searchParams;
        if (query.get('breakdown') !== 'workflow')
          return HttpResponse.json(fixtureStatistics());
        return failing
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.json(fixtureStatistics({ workflows: [] }));
      }),
    );
    renderApp(path);
    await screen.findByText(
      'Recent runs couldn’t be loaded. Try again.',
      {},
      coldStart,
    );
    expect(screen.getByText('8 PB', { selector: 'span' })).toBeVisible();
    failing = false;
    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh recent runs' }),
    );
    expect(
      await screen.findByText('No workflow runs in this window.'),
    ).toBeVisible();
  });

  it('scopes capacity snapshots by identity and workspace with visible-only polling', () => {
    const apiClient = createApiClient({
      fetch,
      readCsrfToken: () => undefined,
    });
    const options = usageCapacityQueryOptions(apiClient, 'reader', 'workspace');
    expect(options.queryKey).toEqual([
      'identity',
      'reader',
      'workspace',
      'workspace',
      'usage-capacity',
    ]);
    expect(options.refetchInterval).toBe(30_000);
    expect(options.refetchIntervalInBackground).toBe(false);
    expect(
      usageCapacityQueryOptions(apiClient, 'other-reader', 'workspace')
        .queryKey,
    ).not.toEqual(options.queryKey);
    expect(
      usageCapacityQueryOptions(apiClient, 'reader', 'other-workspace')
        .queryKey,
    ).not.toEqual(options.queryKey);
  });
});
