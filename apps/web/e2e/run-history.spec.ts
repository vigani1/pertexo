import {
  csrfToken,
  firstRunId,
  installRoutes,
  replayRunId,
  run,
  workflowId,
  workflowVersionId,
  workspaceId,
} from './run-history/fixture';

import { expect, test } from './support/fixtures';

test('filters and paginates workspace history, then opens the exact run', async ({
  page,
}) => {
  await installRoutes(page);
  await page.goto(`/w/${workspaceId}/runs`);

  await expect(
    page
      .getByRole('navigation', { name: 'Workspace' })
      .getByRole('link', { name: /^Runs/u }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('button', { name: 'Copy run ID eeee…eeee' }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Workspace' })
      .getByRole('link', { name: 'Runs, 2 running' }),
  ).toBeVisible();
  await expect(page.getByText(firstRunId)).toHaveCount(0);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(
    page.getByRole('button', { name: 'Copy run ID ffff…ffff' }),
  ).toBeVisible();

  await page.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'Succeeded' }).click();
  await expect(page).toHaveURL(/status=succeeded/u);
  await page.getByLabel('Workflow name').fill('Customer');
  await page.getByLabel('Workflow name').press('Enter');
  await expect(page).toHaveURL(/workflowNamePrefix=Customer/u);
  await page.getByRole('button', { name: 'When: Any time' }).click();
  // Today, twice: a range of just that day.
  const today = page.locator('button[aria-current="date"]');
  await today.click();
  await today.click();
  await page.getByRole('button', { name: 'Apply range' }).click();
  await expect(page).toHaveURL(/createdAtFrom=/u);
  await expect(page).toHaveURL(/range=custom/u);
  await expect(
    page.getByRole('button', { name: 'Copy run ID ffff…ffff' }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Remove filter Status: Succeeded' })
    .click();
  await expect(page).not.toHaveURL(/status=succeeded/u);

  await page.getByRole('link', { name: 'Customer onboarding' }).first().click();
  await expect(page).toHaveURL(`/w/${workspaceId}/runs/${firstRunId}`);
  await expect(
    page.getByRole('heading', { level: 1, name: /^Succeeded in/u }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'v1' })).toHaveAttribute(
    'href',
    `/w/${workspaceId}/workflows/${workflowId}/versions`,
  );
});

test('replays the exact displayed version from its own input', async ({
  context,
  page,
}) => {
  await context.addCookies([
    { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
  ]);
  await installRoutes(page);
  await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);

  await page.getByRole('button', { name: 'Replay' }).click();
  const dialog = page.getByRole('dialog', { name: 'Replay this run' });
  await expect(dialog.getByText(/with this run’s input/u)).toBeVisible();
  const input = dialog.getByLabel('Replay input (JSON)');
  await expect(input).toHaveValue(/"incident": "INC-41"/u);
  await input.fill('{"incident":"INC-42"}');
  await dialog.getByRole('button', { name: 'Replay run' }).click();

  await expect(page).toHaveURL(`/w/${workspaceId}/runs/${replayRunId}`);
  await expect(
    page.getByRole('button', { name: 'Copy run ID 1111…1111' }),
  ).toBeVisible();
  await expect(page.getByText('Replay started')).toBeVisible();
});

test('keeps a maximum-length workflow identity accessible and contained on mobile', async ({
  page,
}) => {
  const workflowName = 'W'.repeat(128);
  await page.setViewportSize({ width: 390, height: 844 });
  await installRoutes(page, workflowName);
  await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);

  await expect(
    page.getByRole('heading', { level: 1, name: /^Succeeded in/u }),
  ).toBeVisible();
  // The breadcrumb names the workflow too; this is the header's own link.
  const name = page.getByRole('main').getByRole('link', { name: workflowName });
  await expect(name).toBeVisible();
  const box = await name.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  await expect(
    page.getByRole('button', { name: 'Copy run ID eeee…eeee' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('contains long applied filters and keeps keyboard removal reachable', async ({
  page,
}, testInfo) => {
  const longPrefix = 'W'.repeat(128);
  await installRoutes(page);
  await page.goto(
    `/w/${workspaceId}/runs?workflowNamePrefix=${longPrefix}&workflowId=${workflowId}`,
  );

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const chip = page.getByRole('button', {
      name: `Remove filter Name: ${longPrefix}`,
    });
    await expect(chip).toHaveAttribute('title', `Name: ${longPrefix}`);
    const box = await chip.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (width === 390) {
      const screenshot = await page.screenshot({ fullPage: true });
      await testInfo.attach('long-applied-filter-390', {
        body: screenshot,
        contentType: 'image/png',
      });
      if (process.env.PERTEXO_VISUAL_EVIDENCE_DIR !== undefined)
        await page.screenshot({
          path: `${process.env.PERTEXO_VISUAL_EVIDENCE_DIR}/long-applied-filter-390.png`,
          fullPage: true,
        });
    }
  }

  const prefixChip = page.getByRole('button', {
    name: `Remove filter Name: ${longPrefix}`,
  });
  await prefixChip.focus();
  await page.keyboard.press('Enter');
  await expect(page).not.toHaveURL(/workflowNamePrefix=/u);
  await expect(page).toHaveURL(new RegExp(`workflowId=${workflowId}`, 'u'));
  await expect(
    page.getByRole('button', {
      name: 'Remove filter Workflow: Customer onboarding',
    }),
  ).toBeVisible();
});

for (const width of [1280, 375])
  test(`shows bounded error-workflow capacity waiting and its refusal at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installRoutes(page);
    let status: 'pending' | 'refused' = 'pending';
    const deadline = new Date(Date.now() + 15 * 60_000).toISOString();
    await page.route(
      `**/v1/workspaces/${workspaceId}/runs/${firstRunId}`,
      (route) =>
        route.fulfill({
          json: {
            run: run(firstRunId, 'failed'),
            nodes: [],
            errorWorkflow: {
              status,
              targetWorkflowId: workflowId,
              targetVersionId: workflowVersionId,
              acceptedRunId: null,
              queueWaitExpiresAt: deadline,
              refusalCode: status === 'pending' ? null : 'queue_full',
            },
          },
        }),
    );
    await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);
    await expect(
      page.getByText('Error workflow is waiting for queue capacity', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText(/^Retries until /u)).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`queue-wait-${String(width)}.png`),
      fullPage: true,
    });
    status = 'refused';
    await expect(
      page.getByText('Error workflow did not start', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/15-minute wait for queue capacity expired/u),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Failed after 2s', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`queue-refused-${String(width)}.png`),
      fullPage: true,
    });
  });
