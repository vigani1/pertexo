import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  fixtureIds,
  fixtureRun,
  fixtureStatistics,
  fixtureTimestamp,
  fixtureWorkflow,
  identityHandlers,
  minutesAgo,
  coldStart,
  statisticsHandler,
} from '../support/run-fixtures';

const workspaceId = fixtureIds.workspace;
const workflowId = fixtureIds.workflow;
const recentRunId = fixtureIds.firstRun;
const failedRunId = fixtureIds.secondRun;
const connectionId = '99999999-9999-4999-8999-999999999999';
const timestamp = fixtureTimestamp;

function workflow(overrides: Record<string, unknown> = {}) {
  return fixtureWorkflow({ name: 'Daily intake', ...overrides });
}

function run(id: string, status: 'succeeded' | 'failed') {
  const createdAt = minutesAgo(status === 'failed' ? 30 : 12);
  return fixtureRun(id, status, {
    workflowName: 'Daily intake',
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    completedAt: minutesAgo(10),
  });
}

type RunReads = Readonly<{
  failed?: () => Response | undefined;
  problems?: readonly ReturnType<typeof run>[];
  any?: readonly ReturnType<typeof run>[];
  statistics?: Parameters<typeof statisticsHandler>[0];
  statisticsSeen?: URLSearchParams[];
}>;

/** Answers every Home run read: statistics, problems, the loom, "any". */
function runHandlers(reads: RunReads = {}, seen: URLSearchParams[] = []) {
  const runs = http.get(
    `http://pertexo.test/v1/workspaces/${workspaceId}/runs`,
    ({ request }) => {
      const query = new URL(request.url).searchParams;
      seen.push(query);
      const status = query.get('status');
      if (status === 'failed') {
        const override = reads.failed?.();
        if (override !== undefined) return override;
        return HttpResponse.json({
          items: reads.problems ?? [run(failedRunId, 'failed')],
          nextCursor: null,
        });
      }
      if (status !== null)
        return HttpResponse.json({ items: [], nextCursor: null });
      if (query.get('limit') === '1')
        return HttpResponse.json({
          items: reads.any ?? [run(recentRunId, 'succeeded')],
          nextCursor: null,
        });
      return HttpResponse.json({
        items: [run(recentRunId, 'succeeded'), run(failedRunId, 'failed')],
        nextCursor: null,
      });
    },
  );
  return [runs, statisticsHandler(reads.statistics, reads.statisticsSeen)];
}

function workflowHandlers(
  items: readonly unknown[] = [workflow()],
  seen: string[] = [],
) {
  return http.get(
    `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
    ({ request }) => {
      seen.push(new URL(request.url).search);
      return HttpResponse.json({ items, nextCursor: null });
    },
  );
}

const readerCapabilities = ['workspace:read', 'workflow:read', 'run:read'];

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
      await screen.findByRole('link', { name: 'Runs, 142 live' }),
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

  it('keeps blocks independent and recovers one failed read', async () => {
    let failedReads = 0;
    let failing = true;
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      workflowHandlers(),
      ...runHandlers({
        // The warm-up read and any mount retry fail until Try again.
        failed: () => {
          failedReads += 1;
          return failing
            ? HttpResponse.json(
                {
                  type: 'urn:pertexo:problem:unexpected',
                  title: 'Unavailable',
                  status: 500,
                  code: 'unexpected',
                  requestId: 'home-failed-read',
                },
                { status: 500 },
              )
            : undefined;
        },
      }),
    );

    renderApp(`/w/${workspaceId}`);
    const attention = await screen.findByRole(
      'region',
      { name: 'Needs attention' },
      coldStart,
    );
    const retry = await within(attention).findByRole('button', {
      name: 'Try again',
    });
    const readsBeforeRetry = failedReads;
    failing = false;
    await userEvent.setup().click(retry);
    expect(screen.getByRole('link', { name: 'Daily intake' })).toBeVisible();
    expect(
      await within(attention).findByText(
        'Daily intake failed once in the last 24 hours',
      ),
    ).toBeVisible();
    expect(failedReads).toBe(readsBeforeRetry + 1);
  });

  it('does not read or show runs without run access', async () => {
    let runReads = 0;
    mockServer.use(
      ...identityHandlers(['workspace:read', 'workflow:read']),
      workflowHandlers(),
      http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/runs`, () => {
        runReads += 1;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );

    renderApp(`/w/${workspaceId}`);
    expect(
      await screen.findByRole('link', { name: 'Daily intake' }, coldStart),
    ).toBeVisible();
    expect(screen.queryByRole('img', { name: /Timeline/u })).toBeNull();
    expect(
      screen.queryByRole('link', { name: 'Failed runs' }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(runReads).toBe(0);
    });
  });

  it('keeps the last result visible when a background refresh fails', async () => {
    let failedReads = 0;
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      workflowHandlers(),
      ...runHandlers({
        failed: () => {
          failedReads += 1;
          return failedReads === 2 ? HttpResponse.error() : undefined;
        },
      }),
    );

    renderApp(`/w/${workspaceId}`);
    const item = await screen.findByText(
      'Daily intake failed once in the last 24 hours',
      undefined,
      coldStart,
    );
    const event = userEvent.setup();
    await event.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(
      await screen.findByText(/Couldn’t refresh. Showing results from/u),
    ).toBeVisible();
    expect(item).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(
        screen.queryByText(/Couldn’t refresh. Showing results from/u),
      ).not.toBeInTheDocument();
    });
    expect(failedReads).toBe(3);
  });

  it('shows a single all-clear line when nothing needs attention', async () => {
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      workflowHandlers(),
      ...runHandlers({ problems: [] }),
    );

    renderApp(`/w/${workspaceId}`);
    const attention = await screen.findByRole(
      'region',
      { name: 'Needs attention' },
      coldStart,
    );
    expect(await within(attention).findByText('All clear.')).toBeVisible();
    expect(within(attention).getByText('Nothing needs you.')).toBeVisible();
  });

  it('lists unhealthy triggers and connections to reconnect with their fixes', async () => {
    mockServer.use(
      ...identityHandlers([
        ...readerCapabilities,
        'connection:read',
        'connection:manage',
      ]),
      workflowHandlers([workflow({ activationStatus: 'degraded' })]),
      ...runHandlers({ problems: [] }),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        () =>
          HttpResponse.json({
            items: [
              {
                id: connectionId,
                workspaceId,
                providerKey: 'slack',
                name: 'Finance bot',
                authType: 'slack_bot_token',
                status: 'reauthorization_required',
                secretVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                health: {
                  lastTestedAt: null,
                  lastHealthyAt: null,
                  lastErrorCode: null,
                },
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            ],
            nextCursor: null,
          }),
      ),
    );

    renderApp(`/w/${workspaceId}`);
    const attention = await screen.findByRole(
      'region',
      { name: 'Needs attention' },
      coldStart,
    );
    expect(
      await within(attention).findByText('Daily intake is degraded'),
    ).toBeVisible();
    expect(
      within(attention).getByRole('link', { name: 'Check triggers' }),
    ).toHaveAttribute(
      'href',
      `/w/${workspaceId}/workflows/${workflowId}/triggers`,
    );
    expect(
      await within(attention).findByText('Finance bot needs reconnecting'),
    ).toBeVisible();
    expect(
      within(attention).getByRole('link', { name: 'Reconnect' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/connections`);
  });

  it('guides a new workspace with its first-thread checklist instead of the loom', async () => {
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      workflowHandlers([]),
      ...runHandlers({ problems: [], any: [] }),
    );

    renderApp(`/w/${workspaceId}`);
    const checklist = await screen.findByRole(
      'region',
      { name: 'Your first thread' },
      coldStart,
    );
    expect(
      within(checklist).getByText('0 of 3 done.', { exact: false }),
    ).toBeVisible();
    expect(
      within(checklist).getByRole('link', { name: 'Create a workflow' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/workflows?create=true`);
    expect(
      within(checklist).getByRole('link', { name: 'Publish it' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/workflows`);
    expect(
      within(checklist).getByRole('link', { name: 'Run it' }),
    ).toBeVisible();
    expect(
      within(checklist).queryByRole('link', { name: 'Invite a teammate' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Timeline/u })).toBeNull();
  });

  it('links every first-thread step to where it is done', async () => {
    const empty = { items: [], nextCursor: null };
    mockServer.use(
      ...identityHandlers([
        ...readerCapabilities,
        'connection:read',
        'workflow:update',
        'member:read',
      ]),
      workflowHandlers([workflow({ publishedVersionId: null })]),
      ...runHandlers({ problems: [], any: [] }),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        () => HttpResponse.json(empty),
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations`,
        () => HttpResponse.json({ items: [] }),
      ),
      http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/members`, () =>
        HttpResponse.json(empty),
      ),
    );

    renderApp(`/w/${workspaceId}`);
    const checklist = await screen.findByRole(
      'region',
      { name: 'Your first thread' },
      coldStart,
    );
    expect(
      await within(checklist).findByText('1 of 6 done.', { exact: false }),
    ).toBeVisible();
    const hrefs = Object.fromEntries(
      within(checklist)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]),
    );
    const base = `/w/${workspaceId}`;
    expect(hrefs).toEqual({
      'Create a workflow': `${base}/workflows?create=true`,
      'Publish it': `${base}/workflows/${workflowId}`,
      'Run it': `${base}/workflows/${workflowId}`,
      'Add a connection': `${base}/connections?add=any`,
      'Set a failure alert': `${base}/alerts`,
      'Invite a teammate': `${base}/team?invite=true`,
    });
  });
});
