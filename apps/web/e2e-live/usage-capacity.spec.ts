import { expect } from '@playwright/test';
import {
  usageCapacityResponseSchema,
  usageTrendsResponseSchema,
  workflowRunStatisticsResponseSchema,
} from '@pertexo/contracts';
import { test } from './support/browser-fixture';

test('reports real current capacity and retained activity with exact drilldowns', async ({
  page,
  request,
}) => {
  const origin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (origin === undefined) throw new Error('Use the owned API fixture');
  const seedResponse = await request.get(`${origin}/usage-seed`);
  expect(seedResponse.ok()).toBe(true);
  const seed = (await seedResponse.json()) as {
    workspaceId: string;
    workflowId: string;
    cookies: { name: string; value: string; url: string }[];
  };
  await page.context().addCookies(seed.cookies);
  const capacityResponse = page.waitForResponse(
    (response) =>
      response
        .url()
        .endsWith(`/v1/workspaces/${seed.workspaceId}/usage-capacity`) &&
      response.status() === 200,
  );
  const oneHourResponse = page.waitForResponse(
    (response) =>
      response
        .url()
        .includes(`/v1/workspaces/${seed.workspaceId}/run-statistics?`) &&
      new URL(response.url()).searchParams.get('window') === '1h' &&
      new URL(response.url()).searchParams.get('breakdown') === 'workflow' &&
      response.status() === 200,
  );
  const path = `/w/${seed.workspaceId}/settings/usage?window=1h`;
  await page.goto(path);
  await expect(
    page.getByRole('heading', { name: 'Usage', exact: true }),
  ).toBeVisible();
  const capacity = usageCapacityResponseSchema.parse(
    await (await capacityResponse).json(),
  );
  expect(capacity.execution).toMatchObject({
    activeRuns: 4,
    reservedActiveSlots: 0,
    activeCapacityConsumed: 4,
    queuedRuns: 1,
    policy: { state: 'active', activeRunLimit: 20, queuedRunLimit: 10_000 },
  });
  expect(capacity.artifacts).toMatchObject({
    chargedBytes: '11',
    chargedCount: 1,
    byteLimit: '1073741824',
    artifactCountLimit: 10_000,
  });
  const current = page.getByRole('region', { name: 'Current capacity' });
  await expect(current.getByTitle('11 bytes')).toHaveText('11 B');
  await expect(
    current.getByRole('figure', { name: '11 B stored of 1 GB' }),
  ).toBeVisible();
  await expect(current).toContainText('/ 1 GB');
  await expect(current).toContainText('4 / 20');
  const oneHour = workflowRunStatisticsResponseSchema.parse(
    await (await oneHourResponse).json(),
  );
  expect(oneHour.window.total).toBe(6);
  const activity = page.getByRole('region', { name: 'Recent runs' });
  const renderedTotal = activity
    .locator('p')
    .filter({ hasText: /runs? started in the last/u });
  await expect(renderedTotal).toHaveText('6 runs started in the last hour');
  const sixHourResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/run-statistics?') &&
      new URL(response.url()).searchParams.get('window') === '6h' &&
      new URL(response.url()).searchParams.get('breakdown') === 'workflow' &&
      response.status() === 200,
  );
  await page.getByRole('button', { name: '6 hours' }).click();
  const sixHour = workflowRunStatisticsResponseSchema.parse(
    await (await sixHourResponse).json(),
  );
  expect(sixHour.window.total).toBe(7);
  await expect(renderedTotal).toHaveText('7 runs started in the last 6 hours');
  await expect(page).toHaveURL(/window=6h/u);
  const failed = page
    .getByRole('list', { name: 'Activity by current run status' })
    .getByRole('link', { name: 'Failed 1' });
  const href = new URL((await failed.getAttribute('href')) ?? '', page.url());
  expect(href.searchParams.get('createdAtFrom')).toBe(
    sixHour.window.createdAtFrom,
  );
  expect(href.searchParams.get('createdAtBefore')).toBe(
    sixHour.window.createdAtBefore,
  );
  expect(href.searchParams.get('status')).toBe('failed');
  await failed.click();
  await expect(
    page.getByRole('heading', { name: 'Runs', exact: true }),
  ).toBeVisible();
  await page.goto(path);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(current.getByTitle('11 bytes')).toHaveText('11 B');
  await page.getByRole('button', { name: '6 hours' }).focus();
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/window=6h/u);
  // A fresh cached window may render without issuing a read. Manual refresh
  // gives the final mobile evidence its own completed authoritative snapshot.
  const mobileResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/run-statistics?') &&
      new URL(response.url()).searchParams.get('window') === '6h' &&
      new URL(response.url()).searchParams.get('breakdown') === 'workflow' &&
      response.status() === 200,
  );
  await page.getByRole('button', { name: 'Refresh recent runs' }).click();
  const mobile = workflowRunStatisticsResponseSchema.parse(
    await (await mobileResponse).json(),
  );
  expect(mobile.window.total).toBe(7);
  await expect(renderedTotal).toHaveText('7 runs started in the last 6 hours');
  await expect(
    page.getByRole('button', { name: 'Refresh recent runs' }),
  ).toBeEnabled();
  await expect(
    activity.getByRole('link', { name: 'View these runs' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/pertexo-usage-live-mobile.png',
    fullPage: true,
  });
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const response = page.waitForResponse(
      (item) =>
        item.url().includes('/usage-trends?period=90d') &&
        item.status() === 200,
    );
    await page.goto(`/w/${seed.workspaceId}/settings/usage/trends?period=90d`);
    const summary = usageTrendsResponseSchema.parse(
      await (await response).json(),
    );
    expect(summary).toMatchObject({
      total: 8,
      elapsed: { measuredRuns: 3, averageMs: 40000, slowestMs: 60000 },
    });
    expect(summary.days).toHaveLength(90);
    await expect(
      page
        .getByRole('region', { name: 'Daily outcomes' })
        .getByText('8 runs', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Elapsed duration' }),
    ).toContainText('40s');
    await expect(
      page.getByRole('region', { name: 'Elapsed duration' }),
    ).toContainText('1m 00s');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/pertexo-f12-trends-live-${String(width)}.png`,
      fullPage: true,
    });
    await page.goto(`/w/${seed.workspaceId}/inbox`);
    await expect(
      page.getByText('Workspace nearing a limit', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('At least 80% of this capacity is in use.', {
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: `/tmp/pertexo-f12-warning-live-${String(width)}.png`,
      fullPage: true,
    });
  }
  const evidence = await request.post(`${origin}/usage-evidence`, {
    data: { workspaceId: seed.workspaceId, observed: true },
  });
  expect(evidence.status()).toBe(204);
});
