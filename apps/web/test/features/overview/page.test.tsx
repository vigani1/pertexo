import { screen, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import {
  coldStart,
  fixtureStatistics,
  identityHandlers,
} from '../../support/fixtures/run';

import { mockServer } from '../../support/mock-server';

import { renderApp } from '../../support/render-app';

import {
  failedRunId,
  readerCapabilities,
  recentRunId,
  runHandlers,
  workflow,
  workflowHandlers,
  workflowId,
  workspaceId,
} from './page/fixture';

describe('workspace home', () => {
  it('makes bounded, capability-scoped reads and links to runs and workflows', async () => {
    const workflowQueries: string[] = [];
    const runQueries: URLSearchParams[] = [];
    const statisticsQueries: URLSearchParams[] = [];
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      workflowHandlers([workflow()], workflowQueries),
      ...runHandlers({ statisticsSeen: statisticsQueries }, runQueries),
    );

    renderApp(`/w/${workspaceId}`, { strict: true });

    expect(
      await screen.findByRole(
        'heading',
        { level: 1, name: 'Control Operations' },
        coldStart,
      ),
    ).toBeVisible();
    const attention = await screen.findByRole(
      'region',
      { name: 'Needs attention' },
      coldStart,
    );
    expect(
      await within(attention).findByText(
        'Daily intake failed once in the last 24 hours',
      ),
    ).toBeVisible();
    expect(
      within(attention).getByRole('link', { name: 'Open run' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/runs/${failedRunId}`);
    const recent = screen.getByRole('region', { name: 'Recently changed' });
    expect(
      within(recent).getByRole('link', { name: 'Daily intake' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/workflows/${workflowId}`);
    expect(within(recent).getByText('Live')).toBeVisible();
    expect(
      await screen.findByRole('img', {
        name: /Timeline of 2 runs across 1 workflow over the last hour/u,
      }),
    ).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByText(/List the 2 runs on this timeline/u));
    expect(
      screen
        .getAllByRole('link')
        .map((link) => link.getAttribute('href'))
        .filter((href) => href?.includes('/runs/')),
    ).toEqual(
      expect.arrayContaining([
        `/w/${workspaceId}/runs/${recentRunId}`,
        `/w/${workspaceId}/runs/${failedRunId}`,
      ]),
    );

    expect(workflowQueries).toEqual(
      expect.arrayContaining([
        '?limit=5&order=updated_desc',
        '?limit=25&order=updated_desc',
      ]),
    );
    const statuses = runQueries.map((query) => query.get('status'));
    // Counts come from statistics; status pages only fetch the Loom's
    // still-active runs from before its window.
    for (const status of ['running', 'waiting', 'queued'])
      expect(
        runQueries
          .filter((query) => query.get('status') === status)
          .every((query) => query.get('createdAtBefore') !== null),
      ).toBe(true);
    expect(statisticsQueries.map(String)).toEqual(
      expect.arrayContaining(['window=24h', 'window=1h&breakdown=workflow']),
    );
    for (const status of ['failed', 'timed_out', 'outcome_unknown']) {
      expect(statuses).toContain(status);
      expect(
        runQueries
          .find((query) => query.get('status') === status)
          ?.get('createdAtFrom'),
      ).toMatch(/Z$/u);
    }
    expect(
      runQueries.some(
        (query) =>
          query.get('status') === null && query.get('createdAtFrom') !== null,
      ),
    ).toBe(true);
    expect(runQueries.some((query) => query.get('limit') === '1')).toBe(true);
  });
  it('shows exact counts from one statistics snapshot in the header and spine', async () => {
    const runQueries: URLSearchParams[] = [];
    mockServer.use(
      ...identityHandlers([...readerCapabilities, 'workflow:create']),
      workflowHandlers(),
      ...runHandlers(
        {
          statistics: () =>
            fixtureStatistics({
              current: { running: 142, waiting: 3, queued: 250 },
              byStatus: { failed: 118, succeeded: 900 },
            }),
        },
        runQueries,
      ),
    );

    renderApp(`/w/${workspaceId}`);
    const main = await screen.findByRole('main', undefined, coldStart);
    expect(
      await within(main).findByText('as of', { exact: false }),
    ).toBeVisible();
    for (const [count, label] of [
      ['142', 'running'],
      ['3', 'waiting'],
      ['250', 'queued'],
      ['118', 'failed in 24 h'],
    ])
      expect(
        within(main)
          .getAllByText(count ?? '', { selector: 'b' })
          .some(
            (figure) =>
              figure.parentElement?.textContent ===
              `${count ?? ''} ${label ?? ''}`,
          ),
      ).toBe(true);
    expect(within(main).getByText('as of', { exact: false })).toBeVisible();
    expect(within(main).queryByText(/\d\+/u)).not.toBeInTheDocument();
    expect(
      await screen.findByRole('link', { name: 'Runs, 142 running' }),
    ).toBeVisible();
    expect(
      runQueries.some(
        (query) =>
          query.get('status') === 'running' &&
          query.get('createdAtBefore') === null,
      ),
    ).toBe(false);
  });
  it('labels the Loom with exact window and lane totals, over 7 days too', async () => {
    const statisticsQueries: URLSearchParams[] = [];
    const runQueries: URLSearchParams[] = [];
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      workflowHandlers(),
      ...runHandlers(
        {
          statisticsSeen: statisticsQueries,
          statistics: (query) => {
            const week = query.get('window') === '7d';
            return fixtureStatistics({
              window: query.get('window') ?? '24h',
              byStatus: { succeeded: week ? 40 : 11, failed: 1 },
              workflows: [
                {
                  workflowId,
                  workflowName: 'Daily intake',
                  total: week ? 41 : 12,
                },
              ],
            });
          },
        },
        runQueries,
      ),
    );

    renderApp(`/w/${workspaceId}`);
    expect(
      await screen.findByText(
        '12 runs in the last hour.',
        undefined,
        coldStart,
      ),
    ).toBeVisible();
    const event = userEvent.setup();
    await event.click(screen.getByText(/List the 2 runs on this timeline/u));
    const lane = screen.getByRole('region', { name: 'Daily intake' });
    expect(within(lane).getByText('12 runs in the last hour')).toBeVisible();

    await event.click(screen.getByRole('button', { name: '7 days' }));
    expect(
      await screen.findByText('41 runs in the last 7 days.'),
    ).toBeVisible();
    expect(statisticsQueries.map(String)).toContain(
      'window=7d&breakdown=workflow',
    );
    const weekStart = runQueries
      .filter(
        (query) =>
          query.get('status') === null && query.get('createdAtFrom') !== null,
      )
      .map((query) => Date.parse(query.get('createdAtFrom') ?? ''))
      .sort((left, right) => left - right)[0];
    expect(Date.now() - (weekStart ?? 0)).toBeGreaterThan(6.9 * 86_400_000);
  });
  it('opens the command palette and a new workflow from the header', async () => {
    mockServer.use(
      ...identityHandlers([...readerCapabilities, 'workflow:create']),
      workflowHandlers(),
      ...runHandlers(),
    );

    renderApp(`/w/${workspaceId}`);
    const main = await screen.findByRole('main', undefined, coldStart);
    expect(
      await within(main).findByRole('link', { name: 'New workflow' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/workflows?create=true`);
    await userEvent
      .setup()
      .click(within(main).getByRole('button', { name: 'Search' }));
    expect(
      await screen.findByRole('dialog', { name: 'Search Pertexo' }),
    ).toBeVisible();
  });
  it('finds any workflow by name from the palette, not only recent ones', async () => {
    const older = workflow({
      id: '77777777-7777-4777-8777-777777777777',
      name: 'Reconcile customers 0517',
    });
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
        ({ request }) => {
          // The first page holds recent workflows; a name query searches all.
          const query = new URL(request.url).searchParams.get('query');
          if (query === null)
            return HttpResponse.json({ items: [workflow()], nextCursor: null });
          return HttpResponse.json({
            items: query.toLowerCase() === 'customers 0517' ? [older] : [],
            nextCursor: null,
          });
        },
      ),
      ...runHandlers(),
    );
    renderApp(`/w/${workspaceId}`);
    const main = await screen.findByRole('main', undefined, coldStart);
    const event = userEvent.setup();
    await event.click(
      await within(main).findByRole('button', { name: 'Search' }),
    );
    const palette = await screen.findByRole('dialog', {
      name: 'Search Pertexo',
    });
    await event.type(
      within(palette).getByRole('combobox', {
        name: 'Search pages, workflows and actions',
      }),
      'customers 0517',
    );
    expect(
      await within(palette).findByRole(
        'option',
        { name: 'Reconcile customers 0517' },
        { timeout: 3_000 },
      ),
    ).toBeVisible();
  });
});
