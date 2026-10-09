import { expect } from '@playwright/test';
import {
  connectionResponseSchema,
  connectionUsageResponseSchema,
} from '@pertexo/contracts';
import { test } from './support/browser-fixture';

test('shows delivered run rejection, explicit recovery, stale-evidence fences and access loss', async ({
  page,
  request,
}) => {
  const origin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (origin === undefined) throw new Error('Use the owned API fixture');
  const seedResponse = await request.get(`${origin}/connection-health-seed`);
  expect(seedResponse.ok()).toBe(true);
  const seed = (await seedResponse.json()) as {
    workspaceId: string;
    connectionId: string;
    workflowId: string;
    token: string;
    replacementToken: string;
    cookies: { name: string; value: string; url: string }[];
  };
  await page.context().addCookies(seed.cookies);
  const path = `/w/${seed.workspaceId}/connections?connection=${seed.connectionId}`;
  const detailPath = `/v1/workspaces/${seed.workspaceId}/connections/${seed.connectionId}`;
  const lens = page.locator('[data-slot="sheet-content"]');
  const readDetail = () =>
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === detailPath &&
        response.request().method() === 'GET' &&
        response.status() === 200,
    );
  const runControl = async (name: string) => {
    const response = await request.post(`${origin}/${name}`);
    expect(response.ok()).toBe(true);
  };
  const initialRead = readDetail();
  await page.goto(path);
  const initial = connectionResponseSchema.parse(
    await (await initialRead).json(),
  );
  expect(initial.health.lastTestedAt).toBeNull();
  await expect(lens.getByText('Unknown', { exact: true })).toBeVisible();

  // These controls drive real published runs through the worker. Only the
  // external Slack HTTP transport is controlled by the owned fixture.
  await runControl('reject-run');
  const rejectedRead = readDetail();
  const usageRead = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${detailPath}/usage` &&
      response.status() === 200,
  );
  await page.reload();
  const rejected = connectionResponseSchema.parse(
    await (await rejectedRead).json(),
  );
  expect(rejected).toMatchObject({
    status: 'reauthorization_required',
    health: {
      lastTestedAt: null,
      lastErrorCode: 'connection.slack_token_revoked',
      lastHealthTransitionSource: 'run',
    },
  });
  expect(rejected.health.lastRunObservedAt).toBeTruthy();
  await expect(
    lens.getByText('Needs reauthorization', { exact: true }),
  ).toBeVisible();
  await expect(
    lens.getByText('run credential rejected · Slack token revoked'),
  ).toBeVisible();
  await expect(
    lens.getByText('Last tested').locator('xpath=following-sibling::dd[1]'),
  ).toHaveText('Never');
  const usageResponse = await usageRead;
  expect(new URL(usageResponse.url()).searchParams.get('limit')).toBe('50');
  const usage = connectionUsageResponseSchema.parse(await usageResponse.json());
  expect(usage.items).toContainEqual(
    expect.objectContaining({
      workflowId: seed.workflowId,
      workflowName: 'Health sender',
      isCurrentPublication: true,
    }),
  );
  const usedBy = lens.getByRole('region', { name: 'Used by' });
  await expect(usedBy.getByRole('link', { name: 'Health sender' })).toHaveCount(
    2,
  );
  await expect(
    usedBy.getByText('Version 2 · Current publication'),
  ).toBeVisible();
  await expect(
    usedBy.getByText('Version 1 · Historical version'),
  ).toBeVisible();
  await lens
    .getByText('Needs reauthorization', { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: '/tmp/pertexo-connection-health-live-desktop.png',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    lens.getByRole('button', { name: 'Test', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/pertexo-connection-health-live-mobile.png',
  });

  await lens.getByRole('button', { name: 'Test', exact: true }).focus();
  await page.keyboard.press('Enter');
  await lens.getByRole('button', { name: 'Test connection' }).click();
  await expect(lens.getByText('Slack accepted the token.')).toBeVisible();
  await lens.getByRole('button', { name: 'Back to details' }).click();
  await expect(lens.getByText('Healthy', { exact: true })).toBeVisible();
  await expect(lens.getByText('From an explicit test')).toBeVisible();
  // A full runtime restart drains provider attempts. The stale-attempt fence
  // therefore uses a second pair of real runs after restart, not a fake hold
  // carried through the runtime's shutdown boundary.
  await runControl('hold-and-reject');
  await page.reload();
  await expect(
    lens.getByText('Needs reauthorization', { exact: true }),
  ).toBeVisible();
  await lens.getByRole('button', { name: 'Test', exact: true }).click();
  await lens.getByRole('button', { name: 'Test connection' }).click();
  await expect(lens.getByText('Slack accepted the token.')).toBeVisible();
  await lens.getByRole('button', { name: 'Back to details' }).click();
  await expect(lens.getByText('Healthy', { exact: true })).toBeVisible();
  await runControl('release-stale-after-test');
  const recoveredRead = readDetail();
  await page.reload();
  const recovered = connectionResponseSchema.parse(
    await (await recoveredRead).json(),
  );
  expect(recovered).toMatchObject({
    status: 'active',
    health: { lastErrorCode: null, lastHealthTransitionSource: 'test' },
  });
  expect(recovered.health.lastTestedAt).toBeTruthy();
  await expect(lens.getByText('Healthy', { exact: true })).toBeVisible();

  await runControl('hold-before-rotation');
  await lens.getByRole('button', { name: 'Replace credential' }).click();
  await lens.getByLabel('Slack bot token').fill(seed.replacementToken);
  await lens.getByRole('button', { name: 'Replace credential' }).click();
  await expect(
    page.getByText('Replaced the bot token for Incident Slack'),
  ).toBeVisible();
  await expect(lens.getByText('Unknown', { exact: true })).toBeVisible();
  await runControl('release-stale-after-rotation');
  const rotatedRead = readDetail();
  await page.reload();
  const rotated = connectionResponseSchema.parse(
    await (await rotatedRead).json(),
  );
  expect(rotated.secretVersionId).not.toBe(initial.secretVersionId);
  expect(rotated).toMatchObject({
    status: 'active',
    health: {
      lastTestedAt: null,
      lastHealthyAt: null,
      lastErrorCode: null,
      lastRunObservedAt: null,
      lastHealthTransitionSource: 'rotation',
    },
  });
  await expect(lens.getByText('Unknown', { exact: true })).toBeVisible();
  await expect(page.getByText(seed.token)).toHaveCount(0);
  await expect(page.getByText(seed.replacementToken)).toHaveCount(0);
  await runControl('deny-membership');
  await page.reload();
  await expect(page.getByText('Incident Slack', { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText('Health sender', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Test connection' }),
  ).toHaveCount(0);
});
