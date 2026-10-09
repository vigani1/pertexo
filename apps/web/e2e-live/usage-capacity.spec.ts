import { expect } from '@playwright/test';
import {
  usageCapacityResponseSchema,
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
    activeRuns: 1,
    reservedActiveSlots: 0,
    activeCapacityConsumed: 1,
    queuedRuns: 1,
    policy: { state: 'active', activeRunLimit: 5, queuedRunLimit: 100 },
  });
  expect(capacity.artifacts).toMatchObject({
    chargedBytes: '11',
    chargedCount: 1,
    byteLimit: '1073741824',
    artifactCountLimit: 1000,
  });
  const current = page.getByRole('region', { name: 'Current capacity' });
  await expect(current.getByText('11', { exact: true })).toBeVisible();
  await expect(current).toContainText('/ 1073741824 bytes');
  await expect(current).toContainText(
    '1 active run (running or waiting) + 0 reserved active slots',
  );
  const oneHour = workflowRunStatisticsResponseSchema.parse(
    await (await oneHourResponse).json(),
  );
  expect(oneHour.window.total).toBe(3);
  const activity = page.getByRole('region', { name: 'Retained run activity' });
  const renderedTotal = activity
    .locator('p')
    .filter({ hasText: 'retained runs created in this window' });
  await expect(renderedTotal).toHaveText(
    '3 retained runs created in this window',
  );
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
  expect(sixHour.window.total).toBe(4);
  await expect(renderedTotal).toHaveText(
    '4 retained runs created in this window',
  );
  await expect(page).toHaveURL(/window=6h/u);
  const failed = page
    .getByRole('list', { name: 'Activity by current run status' })
    .getByRole('link', { name: 'Failed 1' });
  const href = new URL(
    (await failed.getAttribute('href')) ?? '',
    'http://127.0.0.1:4174',
  );
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
  await expect(current.getByText('11', { exact: true })).toBeVisible();
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
  await page
    .getByRole('button', { name: 'Refresh retained run activity' })
    .click();
  const mobile = workflowRunStatisticsResponseSchema.parse(
    await (await mobileResponse).json(),
  );
  expect(mobile.window.total).toBe(4);
  await expect(renderedTotal).toHaveText(
    '4 retained runs created in this window',
  );
  await expect(
    page.getByRole('button', { name: 'Refresh retained run activity' }),
  ).toBeEnabled();
  await expect(
    activity.getByRole('link', { name: 'View runs in this window' }),
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
  const evidence = await request.post(`${origin}/usage-evidence`, {
    data: { workspaceId: seed.workspaceId, observed: true },
  });
  expect(evidence.status()).toBe(204);
});
