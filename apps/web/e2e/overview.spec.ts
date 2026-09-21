import { expect, test, type Page } from '@playwright/test';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const failedRunId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const versionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const timestamp = '2026-09-21T10:00:00.000Z';

async function installRoutes(page: Page) {
  const workflowQueries: string[] = [];
  const runQueries: string[] = [];
  await page.route('**/v1/users/me', (route) =>
    route.fulfill({
      json: {
        id: userId,
        email: 'owner@example.test',
        displayName: 'Workspace Owner',
        status: 'active',
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
    const url = new URL(route.request().url());
    runQueries.push(url.search);
    const failed = url.searchParams.get('status') === 'failed';
    await route.fulfill({
      json: {
        items: [
          run(failed ? failedRunId : runId, failed ? 'failed' : 'succeeded'),
        ],
        nextCursor: null,
      },
    });
  });
  return { workflowQueries, runQueries };
}

function run(id: string, status: 'failed' | 'succeeded') {
  return {
    id,
    workspaceId,
    workflowId,
    workflowVersionId: versionId,
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

test('shows bounded overview lists and keeps source links usable on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const queries = await installRoutes(page);
  await page.goto(`/w/${workspaceId}/overview`);

  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Daily intake')).toBeVisible();
  await expect(page.getByText(`Run ${runId.slice(0, 8)}…`)).toBeVisible();
  await expect(page.getByText(`Run ${failedRunId.slice(0, 8)}…`)).toBeVisible();
  expect(queries.workflowQueries).toContain('?limit=5&order=updated_desc');
  expect(queries.runQueries).toEqual(
    expect.arrayContaining(['?limit=5', '?limit=5&status=failed']),
  );
  await expect(
    page.getByRole('link', { name: 'View failed run history' }),
  ).toHaveAttribute('href', `/w/${workspaceId}/runs?status=failed`);

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('link', { name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Open navigation' }),
  ).toBeFocused();

  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'scroll');
});
