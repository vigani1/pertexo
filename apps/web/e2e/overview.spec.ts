import { expect, test, type Page } from '@playwright/test';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const failedRunId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const versionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const timestamp = '2026-09-21T10:00:00.000Z';

async function installRoutes(page: Page) {
  await page.clock.setFixedTime(new Date(timestamp));
  const workflowQueries: string[] = [];
  const runQueries: URLSearchParams[] = [];
  const statisticsQueries: URLSearchParams[] = [];
  await page.route(
    `**/v1/workspaces/${workspaceId}/run-statistics?**`,
    async (route) => {
      const query = new URL(route.request().url()).searchParams;
      statisticsQueries.push(query);
      await route.fulfill({
        json: statistics(
          query.get('window'),
          query.get('breakdown') === 'workflow',
        ),
      });
    },
  );
  await page.route('**/v1/users/me', (route) =>
    route.fulfill({
      json: {
        id: userId,
        email: 'owner@example.test',
        displayName: 'Workspace Owner',
        status: 'active',
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    }),
  );
  await page.route('**/v1/workspaces?**', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: workspaceId,
            name: 'Control Operations',
            slug: 'control-operations',
            status: 'active',
            revision: 1,
            role: 'owner',
            capabilities: ['workspace:read', 'workflow:read', 'run:read'],
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows?**`,
    async (route) => {
      const url = new URL(route.request().url());
      workflowQueries.push(url.search);
      await route.fulfill({
        json: {
          items: [
            {
              id: workflowId,
              workspaceId,
              name: 'Daily intake',
              nameRevision: 1,
              lifecycleStatus: 'active',
              lifecycleRevision: 1,
              activationStatus: 'inactive',
              publishedVersionId: versionId,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          nextCursor: null,
        },
      });
    },
  );
  await page.route(`**/v1/workspaces/${workspaceId}/runs?**`, async (route) => {
    const query = new URL(route.request().url()).searchParams;
    runQueries.push(query);
    const status = query.get('status');
    await route.fulfill({
      json: {
        items:
          status === 'failed'
            ? [run(failedRunId, 'failed')]
            : status === null
              ? [run(runId, 'succeeded')]
              : [],
        nextCursor: null,
      },
    });
  });
  for (const [id, status] of [
    [runId, 'succeeded'],
    [failedRunId, 'failed'],
  ] as const) {
    await page.route(`**/v1/workspaces/${workspaceId}/runs/${id}`, (route) =>
      route.fulfill({ json: { run: run(id, status), nodes: [] } }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/runs/${id}/events`,
      (route) => route.fulfill({ contentType: 'text/event-stream', body: '' }),
    );
  }
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
    (route) =>
      route.fulfill({
        json: {
          workflow: {
            id: workflowId,
            workspaceId,
            name: 'Daily intake',
            nameRevision: 1,
            lifecycleStatus: 'active',
            lifecycleRevision: 1,
            activationStatus: 'inactive',
            publishedVersionId: versionId,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        },
      }),
  );
  // The navigation fixture retains run summaries, but no source graphs.
  for (const resource of ['draft', 'versions?**', `versions/${versionId}`])
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/${resource}`,
      (route) =>
        route.fulfill({
          status: 404,
          contentType: 'application/problem+json',
          json: {
            type: 'urn:pertexo:problem:resource.not_found',
            title: 'Source not retained',
            status: 404,
            code: 'resource.not_found',
            requestId: 'overview-source-not-retained',
          },
        }),
    );
  return { workflowQueries, runQueries, statisticsQueries };
}

/** A run-statistics snapshot: one running run and two finished in the window. */
function statistics(duration: string | null, breakdown: boolean) {
  const byStatus = {
    queued: 0,
    running: 1,
    waiting: 0,
    succeeded: 1,
    failed: 1,
    canceled: 0,
    timed_out: 0,
    outcome_unknown: 0,
  };
  return {
    asOf: '2026-09-21T10:00:00.000000Z',
    current: { queued: 0, running: 1, waiting: 0 },
    window: {
      duration: duration ?? '24h',
      createdAtFrom: '2026-09-20T10:00:00.000000Z',
      createdAtBefore: '2026-09-21T10:00:00.000000Z',
      total: 3,
      byStatus,
    },
    workflows: breakdown
      ? {
          items: [
            { workflowId, workflowName: 'Daily intake', total: 3, byStatus },
          ],
          truncated: false,
        }
      : null,
  };
}

function run(id: string, status: 'failed' | 'succeeded') {
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

test('shows the loom, what needs attention and recent changes on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const queries = await installRoutes(page);
  await page.goto(`/w/${workspaceId}`);

  await expect(
    page.getByRole('heading', { level: 1, name: 'Control Operations' }),
  ).toBeVisible();
  const attention = page.getByRole('region', { name: 'Needs attention' });
  await expect(
    attention.getByText('Daily intake failed once in the last 24 hours'),
  ).toBeVisible();
  await expect(
    attention.getByRole('link', { name: 'Open run' }),
  ).toHaveAttribute('href', `/w/${workspaceId}/runs/${failedRunId}`);
  await expect(
    page
      .getByRole('region', { name: 'Recently changed' })
      .getByRole('link', { name: 'Daily intake' }),
  ).toHaveAttribute('href', `/w/${workspaceId}/workflows/${workflowId}`);
  await expect(page.getByRole('img', { name: /Timeline of/u })).toBeVisible();
  expect(queries.workflowQueries).toContain('?limit=5&order=updated_desc');
  for (const status of ['running', 'waiting', 'queued', 'failed'])
    expect(
      queries.runQueries.some((query) => query.get('status') === status),
    ).toBe(true);
  expect(
    queries.runQueries
      .find((query) => query.get('status') === 'failed')
      ?.get('createdAtFrom'),
  ).toBeTruthy();
  await expect(page.getByText('3 runs in the last hour.')).toBeVisible();
  expect(queries.statisticsQueries.map(String)).toEqual(
    expect.arrayContaining(['window=24h', 'window=1h&breakdown=workflow']),
  );

  await expect(
    page
      .getByRole('navigation', { name: 'Workspace' })
      .getByRole('link', { name: 'Home' }),
  ).toHaveAttribute('aria-current', 'page');

  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('opens a plotted run from a native timeline link with the keyboard', async ({
  page,
}) => {
  await installRoutes(page);
  await page.goto(`/w/${workspaceId}`);
  const timeline = page.getByRole('group', { name: 'Runs on this timeline' });
  const link = timeline.getByRole('link', { name: /Daily intake: Succeeded/u });
  await expect(link).toHaveAttribute('href', `/w/${workspaceId}/runs/${runId}`);
  await link.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(link).toBeFocused();
  await expect(link.locator('rect')).toHaveCSS(
    'stroke',
    /^(?!rgba\(0, 0, 0, 0\)$).+/u,
  );
  const preview = page.locator('[data-slot="tooltip-content"]');
  await expect(preview).toContainText('Daily intake');
  const bounds = await preview.boundingBox();
  const viewport = page.viewportSize();
  if (bounds === null || viewport === null)
    throw new Error('The timeline preview must be rendered in a viewport.');
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  await page.screenshot({
    path: '/tmp/pertexo-clean-lifecycles.j9etnz/loom-keyboard.png',
  });
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await expect(link).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(
    new RegExp(`/w/${workspaceId}/runs/${runId}$`, 'u'),
  );
});

test('opens a plotted run through its native link on a narrow timeline', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installRoutes(page);
  await page.goto(`/w/${workspaceId}`);
  const link = page
    .getByRole('group', { name: 'Runs on this timeline' })
    .getByRole('link', { name: /Daily intake: Succeeded/u });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(
    new RegExp(`/w/${workspaceId}/runs/${runId}$`, 'u'),
  );
});
