import { expect } from '@playwright/test';
import { workflowConcurrencyCommandResponseSchema } from '@pertexo/contracts/schemas/workflow-authoring';
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
