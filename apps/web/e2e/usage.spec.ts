import { expect, test, type Page } from '@playwright/test';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const timestamp = '2026-09-15T10:00:00.000000Z';
const counts = {
  queued: 1,
  running: 1,
  waiting: 0,
  succeeded: 1,
  failed: 1,
  canceled: 0,
  timed_out: 0,
  outcome_unknown: 0,
};

async function install(
  page: Page,
  options: Readonly<{
    capabilities?: string[];
    state?: string;
    policy?: string;
  }> = {},
) {
  let capacityStatus = 200;
  let activityStatus = 200;
  let capacityBytes = '9007199254740993';
  let activityName = 'Daily intake';
  const requests: string[] = [];
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    if (url.pathname === '/v1/users/me')
      return route.fulfill({
        json: {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          email: 'reader@example.test',
          displayName: 'Usage Reader',
          status: 'active',
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      });
    if (url.pathname === '/v1/workspaces')
      return route.fulfill({
        json: {
          items: [
            {
              id: workspaceId,
              name: 'Usage workshop',
              slug: 'usage-workshop',
              status: options.state ?? 'active',
              revision: 1,
              role: 'operator',
              capabilities: options.capabilities ?? [
                'workspace:read',
                'run:read',
                'artifact:read',
                'workflow:read',
              ],
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          nextCursor: null,
        },
      });
    if (url.pathname.endsWith('/usage-capacity'))
      return capacityStatus === 0
        ? route.abort('failed')
        : capacityStatus !== 200
          ? route.fulfill({
              status: capacityStatus,
              contentType: 'application/problem+json',
              json: {
                type: 'about:blank',
                title: 'Forbidden',
                status: capacityStatus,
                code: 'identity.forbidden',
                requestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              },
            })
          : route.fulfill({
              json: {
                asOf: timestamp,
                execution: {
                  activeRuns: 1,
                  reservedActiveSlots: 1,
                  activeCapacityConsumed: 2,
                  queuedRuns: 1,
                  policy: {
                    state: options.policy ?? 'active',
                    version: 1,
                    activeRunLimit: 5,
                    queuedRunLimit: 100,
                  },
                },
                artifacts: {
                  chargedBytes: capacityBytes,
                  byteLimit: '0',
                  chargedCount: 1,
                  artifactCountLimit: 0,
                  source: 'stored',
                },
              },
            });
    if (url.pathname.endsWith('/run-statistics')) {
      if (
        url.searchParams.get('breakdown') === 'workflow' &&
        activityStatus !== 200
      )
        return activityStatus === 0
          ? route.abort('failed')
          : route.fulfill({ status: activityStatus });
      return route.fulfill({
        json: {
          asOf: timestamp,
          current: { queued: 1, running: 1, waiting: 0 },
          window: {
            duration: url.searchParams.get('window') ?? '24h',
            createdAtFrom: '2026-09-14T10:00:00.123456Z',
            createdAtBefore: timestamp,
            total: 4,
            byStatus: counts,
          },
          workflows:
            url.searchParams.get('breakdown') === 'workflow'
              ? {
                  items: [
                    {
                      workflowId,
                      workflowName: activityName,
                      total: 4,
                      byStatus: counts,
                    },
                  ],
                  truncated: true,
                }
              : null,
        },
      });
    }
    if (url.pathname.endsWith('/runs'))
      return route.fulfill({ json: { items: [], nextCursor: null } });
    return route.fulfill({ status: 404 });
  });
  return {
    requests,
    deny: () => {
      capacityStatus = 403;
    },
    failCapacity: (status: number) => {
      capacityStatus = status;
    },
    failActivity: (status: number) => {
      activityStatus = status;
    },
    authorize: () => {
      capacityStatus = 200;
      activityStatus = 200;
      capacityBytes = '42';
      activityName = 'Fresh activity';
    },
  };
}

test('Usage keeps exact capacity, fixed activity windows, drilldowns and mobile keyboard navigation', async ({
  page,
}) => {
  await install(page, { policy: 'expired' });
  await page.goto(`/w/${workspaceId}/settings/usage?window=1h`);
  await expect(
    page.getByRole('heading', { name: 'Usage', exact: true }),
  ).toBeVisible();
  const capacity = page.getByRole('region', { name: 'Current capacity' });
  await expect(
    capacity.getByText('9007199254740993', { exact: true }),
  ).toBeVisible();
  await expect(capacity).toContainText('/ 0 bytes');
  await expect(capacity).toContainText('Expired');
  await expect(capacity).toContainText('not active for new acceptance');
  await expect(
    page.getByText('Workflow groups shown: 1 (maximum 50).', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: '6 hours' }).click();
  await expect(page).toHaveURL(/window=6h/u);
  const failed = page
    .getByRole('list', { name: 'Activity by current run status' })
    .getByRole('link', { name: 'Failed 1' });
  const href = new URL(
    (await failed.getAttribute('href')) ?? '',
    'http://127.0.0.1:4173',
  );
  expect(href.searchParams.get('createdAtFrom')).toBe(
    '2026-09-14T10:00:00.123456Z',
  );
  expect(href.searchParams.get('createdAtBefore')).toBe(timestamp);
  await failed.click();
  await expect(
    page.getByRole('heading', { name: 'Runs', exact: true }),
  ).toBeVisible();
  await page.goto(`/w/${workspaceId}/settings/usage`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '7 days' }).focus();
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/window=7d/u);
  await expect(page.getByRole('button', { name: '7 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    page.getByRole('button', { name: 'Refresh retained run activity' }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/pertexo-usage-mocked-mobile.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Usage', exact: true }).last(),
  ).toBeVisible();
});

test('Usage removes denied cached capacity without hiding retained activity', async ({
  page,
}) => {
  const { deny, failCapacity, authorize } = await install(page);
  await page.goto(`/w/${workspaceId}/settings/usage`);
  await expect(
    page.getByText('9007199254740993', { exact: true }),
  ).toBeVisible();
  deny();
  await page.getByRole('button', { name: 'Refresh current capacity' }).click();
  await expect(page.getByText('9007199254740993', { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText('Daily intake', { exact: true })).toBeVisible();
  for (const status of [503, 0]) {
    failCapacity(status);
    await page
      .getByRole('button', { name: 'Refresh current capacity' })
      .click();
    await expect(
      page.getByText(
        status === 0
          ? 'Current capacity couldn’t be reached. Check your connection and try again.'
          : 'Current capacity couldn’t be loaded. Try again.',
      ),
    ).toBeVisible();
    await expect(
      page.getByText('9007199254740993', { exact: true }),
    ).toHaveCount(0);
  }
  authorize();
  await page.getByRole('button', { name: 'Refresh current capacity' }).click();
  await expect(page.getByText('42', { exact: true })).toBeVisible();
});

test('Usage forgets denied activity across windows, transient failures and fresh recovery', async ({
  page,
}) => {
  const { failActivity, authorize } = await install(page);
  await page.goto(`/w/${workspaceId}/settings/usage`);
  await expect(page.getByText('Daily intake', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '6 hours' }).click();
  await expect(page).toHaveURL(/window=6h/u);
  await expect(
    page.getByRole('button', { name: 'Refresh retained run activity' }),
  ).toBeEnabled();
  failActivity(404);
  await page
    .getByRole('button', { name: 'Refresh retained run activity' })
    .click();
  await expect(page.getByText('Daily intake', { exact: true })).toHaveCount(0);
  failActivity(503);
  await page.getByRole('button', { name: '24 hours' }).click();
  await expect(
    page.getByText('Retained run activity couldn’t be loaded. Try again.'),
  ).toBeVisible();
  await expect(page.getByText('Daily intake', { exact: true })).toHaveCount(0);
  failActivity(0);
  await page
    .getByRole('button', { name: 'Refresh retained run activity' })
    .click();
  await expect(
    page.getByText(
      'Retained run activity couldn’t be reached. Check your connection and try again.',
    ),
  ).toBeVisible();
  await expect(page.getByText('Daily intake', { exact: true })).toHaveCount(0);
  await expect(
    page.getByText('9007199254740993', { exact: true }),
  ).toBeVisible();
  authorize();
  await page
    .getByRole('button', { name: 'Refresh retained run activity' })
    .click();
  await expect(page.getByText('Fresh activity', { exact: true })).toBeVisible();
});

test('Usage leaves capacity unread in suspended workspaces and roles without artifact access', async ({
  page,
}) => {
  const { requests } = await install(page, {
    state: 'suspended',
    capabilities: ['workspace:read', 'run:read'],
  });
  await page.goto(`/w/${workspaceId}/settings/usage`);
  await expect(
    page.getByText(
      'Current capacity is available only for an active workspace.',
    ),
  ).toBeVisible();
  await expect(page.getByText('Workflow cccc…cccc')).toBeVisible();
  await expect(page.getByText('Daily intake', { exact: true })).toHaveCount(0);
  expect(requests.some((path) => path.endsWith('/usage-capacity'))).toBe(false);
});
