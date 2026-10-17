import { test, expect } from './support/fixtures';
import {
  installEditorRoutes,
  remoteDraft,
  workspaceId,
  workflowId,
} from './workflow-editor/support';
import { fixtureUsageTrends } from '../test/support/fixtures/usage-trends';

for (const width of [1280, 375])
  test(`trends keep all days visible and exact data reachable at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installEditorRoutes(page, remoteDraft());
    const periods: string[] = [];
    const failedReads: string[] = [];
    page.on('response', (response) => {
      if (response.url().includes('/v1/') && response.status() >= 500)
        failedReads.push(response.url());
    });
    const shell = fixtureUsageTrends('30d', workflowId);
    await page.route(
      `**/v1/workspaces/${workspaceId}/run-statistics?*`,
      (route) =>
        route.fulfill({
          json: {
            asOf: shell.asOf,
            current: {
              queued: shell.byStatus.queued,
              running: shell.byStatus.running,
              waiting: shell.byStatus.waiting,
            },
            window: {
              duration: '24h',
              createdAtFrom: '2026-10-16T12:00:00.000000Z',
              createdAtBefore: shell.asOf,
              total: shell.total,
              byStatus: shell.byStatus,
            },
            workflows: null,
          },
        }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/usage-trends?*`,
      (route) => {
        const period =
          new URL(route.request().url()).searchParams.get('period') === '90d'
            ? '90d'
            : '30d';
        periods.push(period);
        return route.fulfill({ json: fixtureUsageTrends(period, workflowId) });
      },
    );
    await page.goto(`/w/${workspaceId}/settings/usage/trends`);
    const outcomes = page.getByRole('region', {
      name: 'Daily outcomes',
      exact: true,
    });
    await expect(outcomes.getByText('3 runs', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('img', { name: /Daily runs by outcome/u }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Elapsed duration' }),
    ).toContainText('30s');
    await page.getByRole('button', { name: '90 days', exact: true }).click();
    await expect(page).toHaveURL(/period=90d/u);
    await expect.poll(() => periods.at(-1)).toBe('90d');
    const chart = page.getByRole('img', { name: /Daily runs by outcome/u });
    expect(
      await chart.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.getByText('Daily data', { exact: true }).click();
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(91);
    const data = page.getByRole('region', {
      name: 'Daily run counts',
      exact: true,
    });
    await data.focus();
    await expect(data).toBeFocused();
    if (width === 375) {
      await data.press('ArrowRight');
      await expect
        .poll(() => data.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(0);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(failedReads).toEqual([]);
    await page.screenshot({
      path: `/tmp/pertexo-f12-trends-${String(width)}.png`,
      fullPage: true,
    });
  });
