import { usageCapacityQueryOptions } from '@/features/usage/data/usage.queries';

import { parseUsageSearch } from '@/features/usage/search.public';

import { createApiClient } from '@/lib/api/client';

import { act, screen, waitFor } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import {
  apiBase,
  coldStart,
  fixtureIds,
  fixtureStatistics,
} from '../../../support/fixtures/run';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

import { capacity, install, path } from './fixture';

describe('workspace Usage', () => {
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
