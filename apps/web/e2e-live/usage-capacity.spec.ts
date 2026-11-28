import { temporaryTestPath } from '../test/support/temporary-test-path';
import { expect } from '@playwright/test';
import {
  usageCapacityResponseSchema,
  usageTrendsResponseSchema,
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
  const path = `/w/${seed.workspaceId}/settings/usage?period=30d`;
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
    policy: { state: 'active', activeRunLimit: 5, queuedRunLimit: 100 },
  });
  expect(capacity.artifacts).toMatchObject({
    chargedBytes: '11',
    chargedCount: 1,
    byteLimit: '1073741824',
    artifactCountLimit: 1000,
  });
  const current = page.getByRole('region', { name: 'Room left' });
  await expect(current.getByTitle('11 bytes')).toHaveText('11 B');
  await expect(
    current.getByRole('img', { name: '0% of file storage used' }),
  ).toBeVisible();
  await expect(current).toContainText('Files use 11 B of 1 GB');
  await expect(current).toContainText(
    'Right now 4 of 5 runs at once are going, with 1 queued behind them.',
  );

  const activity = page.getByRole('region', { name: 'Runs per day' });
  await expect(
    activity.getByRole('img', { name: /Daily runs by outcome, UTC/u }),
  ).toBeVisible();
  const ranking = page.getByRole('region', { name: 'By workflow' });
  const workflow = ranking.getByRole('link', { name: /.+/u }).first();
  await expect(workflow).toHaveAttribute(
    'href',
    `/w/${seed.workspaceId}/workflows/${seed.workflowId}`,
  );
  await workflow.click();
  await expect(page).toHaveURL(
    new RegExp(`/workflows/${seed.workflowId}$`, 'u'),
  );

  await page.goto(path);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(current.getByTitle('11 bytes')).toHaveText('11 B');
  const mobileResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/usage-trends?period=90d') &&
      response.status() === 200,
  );
  await page.getByRole('button', { name: '90 days' }).focus();
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/period=90d/u);
  const mobile = usageTrendsResponseSchema.parse(
    await (await mobileResponse).json(),
  );
  expect(mobile.total).toBe(8);
  expect(mobile.days).toHaveLength(90);
  await expect(activity).toContainText('8 runs');
  await expect(
    activity.getByRole('link', { name: 'Durations and failures by workflow' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: temporaryTestPath('pertexo-usage-live-mobile.png'),
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
      path: temporaryTestPath(`pertexo-f12-trends-live-${String(width)}.png`),
      fullPage: true,
    });
    await page.goto(`/w/${seed.workspaceId}/inbox?filter=all`);
    await expect(
      page.getByText('Workspace nearing a limit', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('At least 80% of this capacity is in use.', {
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: temporaryTestPath(`pertexo-f12-warning-live-${String(width)}.png`),
      fullPage: true,
    });
  }
  const evidence = await request.post(`${origin}/usage-evidence`, {
    data: { workspaceId: seed.workspaceId, observed: true },
  });
  expect(evidence.status()).toBe(204);
});
