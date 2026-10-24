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
  identityHandlers,
  statisticsHandler,
  fixtureStatistics,
} from '../../support/fixtures/run';
import { fixtureUsageTrends } from '../../support/fixtures/usage-trends';
const path = `/w/${fixtureIds.workspace}/settings/usage/trends`;
const caps: AccessibleWorkspace['capabilities'] = [
  'workspace:read',
  'run:read',
  'workflow:read',
];
function install() {
  let status = 200;
  const periods: string[] = [];
  mockServer.use(
    ...identityHandlers(caps),
    statisticsHandler(() => fixtureStatistics()),
    http.get(`${apiBase}/usage-trends`, ({ request }) => {
      const period =
        new URL(request.url).searchParams.get('period') === '90d'
          ? '90d'
          : '30d';
      periods.push(period);
      if (status === 403)
        return HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Forbidden',
            status,
            code: 'auth.forbidden',
            requestId: 'trends-denied',
          },
          { status },
        );
      if (status !== 200) return new HttpResponse('Unavailable', { status });
      return HttpResponse.json(fixtureUsageTrends(period, fixtureIds.workflow));
    }),
  );
  return {
    periods,
    setStatus: (value: number) => {
      status = value;
    },
  };
}
describe('Usage trends', () => {
  it('renders bounded daily outcomes, elapsed durations and workflow rankings', async () => {
    install();
    renderApp(path);
    expect(
      await screen.findByText('3 runs', { selector: 'p' }, coldStart),
    ).toBeVisible();
    expect(
      screen.getByRole('img', { name: /Daily runs by outcome/u }),
    ).toBeVisible();
    expect(
      screen.getByRole('region', { name: 'Elapsed duration' }),
    ).toHaveTextContent('30s');
    expect(
      screen.getByRole('region', { name: 'Elapsed duration' }),
    ).toHaveTextContent('40s');
    expect(
      within(screen.getByRole('region', { name: 'Most runs' })).getByText(
        'Order intake',
      ),
    ).toBeVisible();
    await userEvent.click(
      screen.getByText('Daily data', { selector: 'summary' }),
    );
    expect(screen.getByRole('table')).toBeVisible();
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(
      31,
    );
  });
  it('keeps the period in the URL and requests only bounded trend snapshots', async () => {
    const handlers = install();
    const { router } = renderApp(path);
    await screen.findByText('3 runs', { selector: 'p' }, coldStart);
    await userEvent.click(screen.getByRole('button', { name: '90 days' }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ period: '90d' });
    });
    await waitFor(() => {
      expect(handlers.periods).toContain('90d');
    });
    await userEvent.click(
      screen.getByText('Daily data', { selector: 'summary' }),
    );
    await waitFor(() => {
      expect(
        within(screen.getByRole('table')).getAllByRole('row'),
      ).toHaveLength(91);
    });
  });
  it('forgets denied snapshots across periods before a later transient failure', async () => {
    const handlers = install();
    const { queryClient } = renderApp(path);
    await screen.findByText('3 runs', { selector: 'p' }, coldStart);
    handlers.setStatus(403);
    await act(async () => {
      await queryClient.invalidateQueries({
        predicate: (q) => q.queryKey.includes('usage-trends'),
      });
    });
    await waitFor(() =>
      expect(screen.queryByText('3 runs')).not.toBeInTheDocument(),
    );
    handlers.setStatus(503);
    await userEvent.click(screen.getByRole('button', { name: '90 days' }));
    await waitFor(() => {
      expect(handlers.periods).toContain('90d');
    });
    expect(screen.queryByText('3 runs')).not.toBeInTheDocument();
    expect(screen.queryByText('Order intake')).not.toBeInTheDocument();
    handlers.setStatus(200);
    await act(async () => {
      await queryClient.invalidateQueries({
        predicate: (q) => q.queryKey.includes('usage-trends'),
      });
    });
    expect(await screen.findByText('3 runs', { selector: 'p' })).toBeVisible();
  });
});
