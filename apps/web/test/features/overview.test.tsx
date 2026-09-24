import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  fixtureIds,
  fixtureRun,
  fixtureTimestamp,
  fixtureWorkflow,
  identityHandlers,
  minutesAgo,
  coldStart,
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
}>;

/** Answers every Home run read: status counts, problems, the loom, "any". */
function runHandlers(reads: RunReads = {}, seen: URLSearchParams[] = []) {
  return http.get(
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
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      workflowHandlers([workflow()], workflowQueries),
      runHandlers({}, runQueries),
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
      expect.arrayContaining(['?limit=5&order=updated_desc', '?limit=25']),
    );
    const statuses = runQueries.map((query) => query.get('status'));
    for (const status of ['running', 'waiting', 'queued'])
      expect(
        runQueries
          .find((query) => query.get('status') === status)
          ?.get('limit'),
      ).toBe('100');
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

  it('keeps blocks independent and recovers one failed read', async () => {
    let failedReads = 0;
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      workflowHandlers(),
      runHandlers({
        failed: () => {
          failedReads += 1;
          return failedReads <= 2
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
    await userEvent
      .setup()
      .click(
        await within(attention).findByRole('button', { name: 'Try again' }),
      );
    expect(screen.getByRole('link', { name: 'Daily intake' })).toBeVisible();
    expect(
      await within(attention).findByText(
        'Daily intake failed once in the last 24 hours',
      ),
    ).toBeVisible();
    expect(failedReads).toBe(3);
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
      runHandlers({
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
      runHandlers({ problems: [] }),
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
      runHandlers({ problems: [] }),
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
      runHandlers({ problems: [], any: [] }),
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
    ).toHaveAttribute('href', `/w/${workspaceId}/workflows`);
    expect(
      within(checklist).getByRole('link', { name: 'Run it' }),
    ).toBeVisible();
    expect(
      within(checklist).queryByRole('link', { name: 'Invite a teammate' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Timeline/u })).toBeNull();
  });
});
