import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const recentRunId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const failedRunId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const versionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const timestamp = '2026-09-21T10:00:00.000Z';

const user = {
  id: userId,
  email: 'owner@example.test',
  displayName: 'Workspace Owner',
  status: 'active',
  createdAt: timestamp,
  updatedAt: timestamp,
};

function workspace(capabilities: readonly string[]) {
  return {
    id: workspaceId,
    name: 'Control Operations',
    slug: 'control-operations',
    status: 'active',
    revision: 1,
    role: 'owner',
    capabilities,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function workflow() {
  return {
    id: workflowId,
    workspaceId,
    name: 'Daily intake',
    lifecycleStatus: 'active',
    lifecycleRevision: 1,
    activationStatus: 'inactive',
    publishedVersionId: versionId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function run(id: string, status: 'succeeded' | 'failed') {
  return {
    id,
    workspaceId,
    workflowId,
    workflowVersionId: versionId,
    workflowName: 'Daily intake',
    status,
    triggerType: 'manual',
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    deadlineAt: null,
    cancelRequestedAt: null,
  };
}

function identityHandlers(capabilities: readonly string[]) {
  return [
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({
        items: [workspace(capabilities)],
        nextCursor: null,
      }),
    ),
  ];
}

describe('workspace overview', () => {
  it('requests bounded source-owned recent lists and links to their source pages', async () => {
    const workflowQueries: string[] = [];
    const runQueries: string[] = [];
    mockServer.use(
      ...identityHandlers(['workspace:read', 'workflow:read', 'run:read']),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
        ({ request }) => {
          workflowQueries.push(new URL(request.url).search);
          return HttpResponse.json({ items: [workflow()], nextCursor: null });
        },
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/runs`,
        ({ request }) => {
          const query = new URL(request.url).searchParams;
          runQueries.push(new URL(request.url).search);
          return HttpResponse.json({
            items: [
              query.get('status') === 'failed'
                ? run(failedRunId, 'failed')
                : run(recentRunId, 'succeeded'),
            ],
            nextCursor: null,
          });
        },
      ),
    );

    renderApp(`/w/${workspaceId}/overview`, { strict: true });

    expect(
      await screen.findByRole('heading', { name: 'Overview' }),
    ).toBeVisible();
    expect(
      screen
        .getAllByRole('link', { name: 'Daily intake' })
        .find(
          (link) =>
            link.getAttribute('href') ===
            `/w/${workspaceId}/workflows/${workflowId}`,
        ),
    ).toBeDefined();
    expect(
      screen
        .getAllByRole('link', { name: 'Daily intake' })
        .map((link) => link.getAttribute('href')),
    ).toEqual(
      expect.arrayContaining([
        `/w/${workspaceId}/runs/${recentRunId}`,
        `/w/${workspaceId}/runs/${failedRunId}`,
      ]),
    );
    expect(
      screen.getByRole('link', { name: 'View failed run history' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/runs?status=failed`);
    expect(workflowQueries).toEqual(['?limit=5&order=updated_desc']);
    expect(runQueries).toEqual(
      expect.arrayContaining(['?limit=5', '?limit=5&status=failed']),
    );
  });

  it('keeps cards independent and recovers one failed refresh', async () => {
    let failedReads = 0;
    mockServer.use(
      ...identityHandlers(['workspace:read', 'workflow:read', 'run:read']),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
        () => HttpResponse.json({ items: [workflow()], nextCursor: null }),
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/runs`,
        ({ request }) => {
          const failed =
            new URL(request.url).searchParams.get('status') === 'failed';
          if (failed) {
            failedReads += 1;
            if (failedReads <= 2)
              return HttpResponse.json(
                {
                  type: 'urn:pertexo:problem:unexpected',
                  title: 'Unavailable',
                  status: 500,
                  code: 'unexpected',
                  requestId: 'overview-failed-refresh',
                },
                { status: 500 },
              );
          }
          return HttpResponse.json({
            items: [
              failed
                ? run(failedRunId, 'failed')
                : run(recentRunId, 'succeeded'),
            ],
            nextCursor: null,
          });
        },
      ),
    );

    renderApp(`/w/${workspaceId}/overview`);
    expect((await screen.findAllByText('Daily intake')).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText(/Run dddddddd…/u)).toBeVisible();
    const failedCard = screen
      .getByRole('heading', { name: 'Recent failed runs' })
      .closest('section');
    if (failedCard === null) throw new Error('Missing failed-runs card');
    await userEvent.setup().click(
      await within(failedCard).findByRole('button', {
        name: 'Try again',
      }),
    );
    expect(await screen.findByText(/Run eeeeeeee…/u)).toBeVisible();
    expect(failedReads).toBe(3);
  });

  it('does not request or render cards the actor cannot read', async () => {
    let runReads = 0;
    mockServer.use(
      ...identityHandlers(['workspace:read', 'workflow:read']),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
        () => HttpResponse.json({ items: [workflow()], nextCursor: null }),
      ),
      http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/runs`, () => {
        runReads += 1;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );

    renderApp(`/w/${workspaceId}/overview`);
    expect(await screen.findByText('Daily intake')).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'Recent runs' }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(runReads).toBe(0);
    });
  });

  it('keeps the last successful card result during a failed background refresh', async () => {
    let failedReads = 0;
    mockServer.use(
      ...identityHandlers(['workspace:read', 'workflow:read', 'run:read']),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
        () => HttpResponse.json({ items: [workflow()], nextCursor: null }),
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/runs`,
        ({ request }) => {
          const failed =
            new URL(request.url).searchParams.get('status') === 'failed';
          if (failed) {
            failedReads += 1;
            if (failedReads === 2) return HttpResponse.error();
          }
          return HttpResponse.json({
            items: [
              failed
                ? run(failedRunId, 'failed')
                : run(recentRunId, 'succeeded'),
            ],
            nextCursor: null,
          });
        },
      ),
    );

    renderApp(`/w/${workspaceId}/overview`);
    expect(await screen.findByText(/Run eeeeeeee…/u)).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Refresh' }));
    expect(
      await screen.findByText(
        'Showing the last successful result because refresh failed.',
      ),
    ).toBeVisible();
    expect(screen.getByText(/Run eeeeeeee…/u)).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Retry refresh' }));
    await waitFor(() => {
      expect(
        screen.queryByText(
          'Showing the last successful result because refresh failed.',
        ),
      ).not.toBeInTheDocument();
    });
    expect(failedReads).toBe(3);
  });
});
