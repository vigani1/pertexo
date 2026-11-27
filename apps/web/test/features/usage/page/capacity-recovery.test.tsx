import { usageCapacityQueryOptions } from '@/features/usage/data/usage.queries';
import { parseUsageSearch } from '@/features/usage/usage-routing.public';
import { createApiClient } from '@/lib/api/client';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { coldStart, fixtureIds } from '../../../support/fixtures/run';
import { fixtureUsageTrends } from '../../../support/fixtures/usage-trends';
import { renderLoadedApp } from '../../../support/render-app';
import { capacity, install, path } from './fixture';

const refreshRuns = () =>
  userEvent.click(screen.getByRole('button', { name: 'Refresh runs per day' }));

describe('workspace Usage', () => {
  it.each([401, 403, 404, 409])(
    'forgets runs per day after %s and recovers only with fresh success',
    async (denial) => {
      let status = 200;
      let fresh = false;
      install({
        trendsResponse: () => {
          const trends = fixtureUsageTrends('30d', fixtureIds.workflow);
          const busiest = trends.busiest.map((item) => ({
            ...item,
            workflowName: fresh ? 'Fresh activity' : 'Old activity',
          }));
          return status === 200
            ? HttpResponse.json({ ...trends, busiest })
            : new HttpResponse(null, { status });
        },
      });
      const { router } = await renderLoadedApp(path);
      await screen.findByText('Old activity', {}, coldStart);
      status = 503;
      await refreshRuns();
      await screen.findByText(/Couldn’t refresh. Showing results/u);
      expect(screen.getByText('Old activity')).toBeVisible();
      status = denial;
      await refreshRuns();
      await waitFor(() =>
        expect(screen.queryByText('Old activity')).not.toBeInTheDocument(),
      );
      status = 503;
      await refreshRuns();
      await screen.findByText('Runs per day couldn’t be loaded. Try again.');
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
          search: { period: '30d' },
        }),
      );
      await screen.findByText('Runs per day couldn’t be loaded. Try again.');
      expect(screen.queryByText('Old activity')).not.toBeInTheDocument();
      expect(screen.getByText('8 PB', { selector: 'span' })).toBeVisible();
      status = 200;
      fresh = true;
      await refreshRuns();
      expect(await screen.findByText('Fresh activity')).toBeVisible();
      expect(screen.queryByText('Old activity')).not.toBeInTheDocument();
    },
  );

  it('recovers the failed capacity read on its own', async () => {
    let failing = true;
    install({
      capacityResponse: () =>
        failing
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.json(capacity),
    });
    await renderLoadedApp(path);
    await screen.findByText(
      'Room left couldn’t be loaded. Try again.',
      {},
      coldStart,
    );
    expect(screen.getByText('Order intake')).toBeVisible();
    failing = false;
    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh room left' }),
    );
    expect(await screen.findByText('8 PB', { selector: 'span' })).toBeVisible();
  });

  it('keeps only the periods the server summarises', () => {
    expect(parseUsageSearch({ period: '7d' })).toEqual({ period: '30d' });
    expect(parseUsageSearch({ period: '90d', timezone: 'UTC' })).toEqual({
      period: '90d',
    });
  });

  it('keeps room left when runs per day fail, and recovers them on their own', async () => {
    let failing = true;
    install({
      trendsResponse: () =>
        failing
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.json(fixtureUsageTrends('30d', fixtureIds.workflow)),
    });
    await renderLoadedApp(path);
    await screen.findByText(
      'Runs per day couldn’t be loaded. Try again.',
      {},
      coldStart,
    );
    expect(screen.getByText('8 PB', { selector: 'span' })).toBeVisible();
    failing = false;
    await refreshRuns();
    expect(await screen.findByText('Order intake')).toBeVisible();
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
