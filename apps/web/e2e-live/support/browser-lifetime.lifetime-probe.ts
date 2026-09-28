import { test as ownedTest } from './browser-fixture';

// No application, API, database or Redis. Exercise real Playwright fixture setup
// and worker restart while the parent records only non-secret lifetime receipts.
const scenario = process.env.PERTEXO_BROWSER_LIFETIME_PROBE;
const test = ownedTest.extend({
  launchOptions: [
    async ({ launchOptions }, use, workerInfo) => {
      const failLaunch =
        scenario === 'initial-launch-failure' ||
        (scenario === 'restarted-launch-failure' && workerInfo.workerIndex > 0);
      await use(
        failLaunch
          ? {
              ...launchOptions,
              executablePath:
                '/pertexo-browser-lifetime-probe/missing-chromium',
            }
          : launchOptions,
      );
    },
    { scope: 'worker' },
  ],
});

test('first browser has ordinary context behavior', async ({ page }) => {
  await page.goto('about:blank');
});

if (scenario === 'restarted-launch-failure') {
  test('failure disposes the earlier browser before worker restart', async ({
    page,
  }) => {
    await page.goto('about:blank');
    throw new Error('Intentional isolated worker restart');
  });
  test('replacement worker cannot reuse the earlier close receipt', async ({
    page,
  }) => {
    await page.goto('about:blank');
  });
}
