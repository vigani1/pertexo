import { expectAccessibleInBothThemes } from './support/accessibility';
import { temporaryTestPath } from '../test/support/temporary-test-path';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import {
  createUserFixture,
  createWorkspaceFixture,
} from '../test/support/fixtures/identity';
import { expect, test, type Page } from './support/fixtures';
import { fixtureUsageTrends } from '../test/support/fixtures/usage-trends';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const timestamp = '2026-09-15T10:00:00.000000Z';
async function install(
  page: Page,
  options: Readonly<{
    capabilities?: AccessibleWorkspace['capabilities'];
    state?: AccessibleWorkspace['status'];
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
        json: createUserFixture({
          email: 'reader@example.test',
          displayName: 'Usage Reader',
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      });
    if (url.pathname === '/v1/workspaces')
      return route.fulfill({
        json: {
          items: [
            createWorkspaceFixture({
              id: workspaceId,
              name: 'Usage workshop',
              slug: 'usage-workshop',
              status: options.state ?? 'active',
              role: 'operator',
              capabilities: options.capabilities ?? [
                'workspace:read',
                'run:read',
                'artifact:read',
                'workflow:read',
              ],
              createdAt: timestamp,
              updatedAt: timestamp,
            }),
          ],
          nextCursor: null,
        },
      });
    if (url.pathname.endsWith('/usage-capacity')) {
      if (capacityStatus === 0) return route.abort('failed');
      if (capacityStatus !== 200)
        return route.fulfill({
          status: capacityStatus,
          contentType: 'application/problem+json',
          json: {
            type: 'about:blank',
            title: 'Forbidden',
            status: capacityStatus,
            code: 'identity.forbidden',
            requestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          },
        });
      return route.fulfill({
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
    }
    if (url.pathname.endsWith('/usage-trends')) {
      if (activityStatus !== 200)
        return activityStatus === 0
          ? route.abort('failed')
          : route.fulfill({ status: activityStatus });
      const trends = fixtureUsageTrends(
        url.searchParams.get('period') === '90d' ? '90d' : '30d',
        workflowId,
      );
      return route.fulfill({
        json: {
          ...trends,
          busiest: trends.busiest.map((item) => ({
            ...item,
            workflowName: activityName,
          })),
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

test('Usage says how much room is left, keeps the range in the URL and fits a phone', async ({
  page,
}) => {
  await install(page, { policy: 'expired' });
  await page.goto(`/w/${workspaceId}/settings/usage?period=90d`);
  await expect(
    page.getByRole('heading', { name: 'Usage', exact: true }),
  ).toBeVisible();
  const room = page.getByRole('region', { name: 'Room left' });
  await expect(room.getByText('8 PB', { exact: true }).first()).toBeVisible();
  await expect(room).toContainText('of 0 B');
  await expect(room).toContainText('limits are expired');
  await expect(room).toContainText('New runs aren’t accepted right now');
  await expect(
    page
      .getByRole('region', { name: 'By workflow' })
      .getByText('Daily intake', { exact: true }),
  ).toBeVisible();
  await expectAccessibleInBothThemes(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '30 days' }).focus();
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/period=30d/u);
  await expect(page.getByRole('button', { name: '30 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: temporaryTestPath('pertexo-usage-mocked-mobile.png'),
    fullPage: true,
  });
  // On a phone, Settings' sections sit behind one button naming the open
  // one, by the words it shows.
  const sections = page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: /^Settings · Usage\b/u });
  await sections.click();
  await expect(
    page
      .getByRole('dialog', { name: 'Settings' })
      .getByRole('link', { name: 'Usage', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'More' }).getByRole('link', {
      name: 'Settings',
    }),
  ).toHaveAttribute('aria-current', 'page');
});

test('Usage removes denied cached capacity without hiding runs per day', async ({
  page,
}) => {
  const { deny, failCapacity, authorize } = await install(page);
  await page.goto(`/w/${workspaceId}/settings/usage`);
  await expect(page.getByText('8 PB', { exact: true }).first()).toBeVisible();
  deny();
  await page.getByRole('button', { name: 'Refresh room left' }).click();
  await expect(page.getByText('8 PB', { exact: true }).first()).toHaveCount(0);
  await expect(page.getByText('Daily intake', { exact: true })).toBeVisible();
  for (const status of [503, 0]) {
    failCapacity(status);
    await page.getByRole('button', { name: 'Refresh room left' }).click();
    await expect(
      page.getByText(
        status === 0
          ? 'Room left couldn’t be reached. Check your connection and try again.'
          : 'Room left couldn’t be loaded. Try again.',
      ),
    ).toBeVisible();
    await expect(page.getByText('8 PB', { exact: true }).first()).toHaveCount(
      0,
    );
  }
  authorize();
  await page.getByRole('button', { name: 'Refresh room left' }).click();
  await expect(page.getByText('42 B', { exact: true }).first()).toBeVisible();
});

test('Usage forgets denied runs per day across ranges, transient failures and fresh recovery', async ({
  page,
}) => {
  const { failActivity, authorize } = await install(page);
  await page.goto(`/w/${workspaceId}/settings/usage`);
  await expect(page.getByText('Daily intake', { exact: true })).toBeVisible();
  failActivity(404);
  await page.getByRole('button', { name: 'Refresh runs per day' }).click();
  await expect(page.getByText('Daily intake', { exact: true })).toHaveCount(0);
  failActivity(503);
  await page.getByRole('button', { name: '90 days' }).click();
  await expect(
    page.getByText('Runs per day couldn’t be loaded. Try again.'),
  ).toBeVisible();
  await expect(page.getByText('Daily intake', { exact: true })).toHaveCount(0);
  failActivity(0);
  await page.getByRole('button', { name: 'Refresh runs per day' }).click();
  await expect(
    page.getByText(
      'Runs per day couldn’t be reached. Check your connection and try again.',
    ),
  ).toBeVisible();
  await expect(page.getByText('Daily intake', { exact: true })).toHaveCount(0);
  await expect(page.getByText('8 PB', { exact: true }).first()).toBeVisible();
  authorize();
  await page.getByRole('button', { name: 'Refresh runs per day' }).click();
  await expect(page.getByText('Fresh activity', { exact: true })).toBeVisible();
});

test('Usage leaves capacity unread for roles without artifact access', async ({
  page,
}) => {
  const { requests } = await install(page, {
    state: 'active',
    capabilities: ['workspace:read', 'run:read'],
  });
  await page.goto(`/w/${workspaceId}/settings/usage`);
  await expect(
    page.getByText('You need access to runs and files to see capacity.'),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'By workflow' })).toBeVisible();
  expect(requests.some((path) => path.endsWith('/usage-capacity'))).toBe(false);
});
