import { expect } from '@playwright/test';
import { workflowConcurrencyCommandResponseSchema } from '@pertexo/contracts';
import { test } from './support/browser-fixture';

test('sets cap one, sees the real blocked run across restart, then removes the cap', async ({
  page,
  request,
}) => {
  const origin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (origin === undefined)
    throw new Error('Use the owned concurrency fixture');
  const seedResponse = await request.get(`${origin}/concurrency-seed`);
  expect(seedResponse.ok()).toBe(true);
  const seed = (await seedResponse.json()) as {
    workspaceId: string;
    workflowId: string;
    cookies: { name: string; value: string; url: string }[];
  };
  await page.context().addCookies(seed.cookies);
  const settingsPath = `/w/${seed.workspaceId}/workflows/${seed.workflowId}/settings`;
  await page.goto(settingsPath);
  const input = page.getByRole('textbox', {
    name: 'Runs at once',
    exact: true,
  });
  await expect(input).toBeVisible();
  await input.fill('1');
  const applied = page.waitForResponse(
    (response) =>
      response.url().endsWith('/concurrency') &&
      response.request().method() === 'PUT' &&
      response.status() === 200,
  );
  await page.getByRole('button', { name: 'Save concurrency limit' }).click();
  expect(
    workflowConcurrencyCommandResponseSchema.parse(await (await applied).json())
      .settings.limit,
  ).toBe(1);
  const accepted = await request.post(`${origin}/start-runs`);
  expect(accepted.ok()).toBe(true);
  await page.goto(`/w/${seed.workspaceId}/workflows/${seed.workflowId}/runs`);
  await expect(
    page.getByText(/Waiting for workflow concurrency capacity/u).first(),
  ).toBeVisible();
  const restarted = await request.post(`${origin}/restart`);
  expect(restarted.ok()).toBe(true);
  await page.reload();
  await expect(
    page.getByText(/Waiting for workflow concurrency capacity/u).first(),
  ).toBeVisible();
  await page.goto(settingsPath);
  await expect(input).toHaveValue('1');
  await page
    .getByRole('combobox', { name: 'When the limit is reached' })
    .click();
  await page.getByRole('option', { name: 'Skip', exact: true }).click();
  const skippedPolicy = page.waitForResponse(
    (response) =>
      response.url().endsWith('/concurrency') &&
      response.request().method() === 'PUT' &&
      response.status() === 200,
  );
  await page.getByRole('button', { name: 'Save concurrency limit' }).click();
  expect(
    workflowConcurrencyCommandResponseSchema.parse(
      await (await skippedPolicy).json(),
    ).settings.overflow,
  ).toBe('skip');
  expect((await request.post(`${origin}/refuse-start`)).ok()).toBe(true);
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(
      page.getByRole('combobox', { name: 'When the limit is reached' }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/pertexo-concurrency-skip-${String(width)}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await input.fill('');
  const removed = page.waitForResponse(
    (response) =>
      response.url().endsWith('/concurrency') &&
      response.request().method() === 'PUT' &&
      response.status() === 200,
  );
  await page.getByRole('button', { name: 'Save concurrency limit' }).click();
  expect(
    workflowConcurrencyCommandResponseSchema.parse(await (await removed).json())
      .settings.limit,
  ).toBeNull();
  expect((await request.post(`${origin}/released-evidence`)).ok()).toBe(true);
  await expect(
    page.getByText(
      'Current limit: no additional workflow limit. Workspace limits still apply.',
    ),
  ).toBeVisible();
  await page.screenshot({
    path: '/tmp/pertexo-workflow-concurrency-live.png',
    fullPage: true,
  });
});
