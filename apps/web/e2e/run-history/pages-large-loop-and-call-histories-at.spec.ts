import {
  firstRunId,
  installRoutes,
  run,
  secondRunId,
  timestamp,
  workflowId,
  workflowVersionId,
  workspaceId,
} from './fixture';

import { expect, test } from '../support/fixtures';

for (const width of [1280, 375])
  test(`pages large loop and Call histories at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installRoutes(page);
    await page.route(
      `**/v1/workspaces/${workspaceId}/runs/${firstRunId}`,
      (route) =>
        route.fulfill({
          json: {
            run: run(firstRunId, 'succeeded'),
            nodes: Array.from({ length: 2_501 }, (_, index) => ({
              id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
              nodeId: 'item',
              invocationKey: `item-${String(index).padStart(4, '0')}`,
              status: 'succeeded',
              currentAttemptNumber: 1,
              startedAt: timestamp,
              completedAt: '2026-09-15T10:00:01.000Z',
              resumeAt: null,
              safeErrorCode: null,
            })),
            calls: Array.from({ length: 2_499 }, (_, index) => ({
              id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
              invocationKey: `call-${String(index)}`,
              targetWorkflowId: workflowId,
              targetVersionId: workflowVersionId,
              childRunId: secondRunId,
              childHistory: 'retained',
              status: 'succeeded',
              slotLent: false,
              detailsRetired: false,
              safeErrorCode: null,
            })),
          },
        }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/runs/${firstRunId}/node-runs/*/input`,
      (route) => route.fulfill({ json: { input: { kind: 'none' } } }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/runs/${firstRunId}/node-runs/*/output`,
      (route) => route.fulfill({ json: { output: { kind: 'none' } } }),
    );
    await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);
    const steps = page.getByRole('navigation', { name: 'Step history pages' });
    await expect(steps).toHaveText(/2,501–2,501 of 2,501/u);
    await expect(page.getByRole('button', { name: /^item/u })).toHaveCount(1);
    await steps.getByRole('button', { name: 'Previous' }).click();
    await expect(steps).toHaveText(/2,451–2,500 of 2,501/u);
    await expect(page.getByRole('button', { name: /^item/u })).toHaveCount(50);
    const calls = page.getByRole('navigation', {
      name: 'Called workflow pages',
    });
    await expect(calls).toHaveText(/1–50 of 2,499/u);
    await expect(
      page.getByRole('link', { name: 'Open child run' }),
    ).toHaveCount(50);
    await calls.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Call 51', { exact: true })).toBeVisible();
    await expect(calls).toHaveText(/51–100 of 2,499/u);
    await page.getByRole('tab', { name: 'Input & output' }).click();
    const results = page.getByRole('navigation', { name: 'Step result pages' });
    await expect(results).toHaveText(/2,501–2,501 of 2,501/u);
    await results.getByRole('button', { name: 'Previous' }).click();
    await expect(results).toHaveText(/2,451–2,500 of 2,501/u);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (process.env.PERTEXO_VISUAL_EVIDENCE_DIR !== undefined)
      await page.screenshot({
        path: `${process.env.PERTEXO_VISUAL_EVIDENCE_DIR}/loop-history-${String(width)}.png`,
        fullPage: false,
      });
    await testInfo.attach(`loop-history-${String(width)}`, {
      body: await page.screenshot({ fullPage: false }),
      contentType: 'image/png',
    });
  });

for (const theme of ['light', 'dark'] as const)
  for (const width of [375, 990, 1440])
    test(`finds exact business values and reads their run in ${theme} at ${String(width)}px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 800 });
      await page.addInitScript((choice) => {
        localStorage.setItem('pertexo.appearance', choice);
      }, theme);
      await installRoutes(page);
      await page.route(
        `**/v1/workspaces/${workspaceId}/runs/${firstRunId}`,
        (route) =>
          route.fulfill({
            json: {
              run: {
                ...run(firstRunId, 'succeeded'),
                runValues: { orderId: 'A-1042', empty: '' },
              },
              nodes: [],
            },
          }),
      );
      await page.goto(`/w/${workspaceId}/runs`);
      await page.getByRole('button', { name: 'Run value: any' }).click();
      const valueFilter = page.getByRole('dialog', {
        name: 'Find runs by a saved value',
      });
      await valueFilter.getByLabel('Name', { exact: true }).fill('orderId');
      await valueFilter.getByLabel('Value', { exact: true }).fill('A-1042');
      const request = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return (
          url.pathname.endsWith('/runs') &&
          url.searchParams.get('runValueKey') === 'orderId' &&
          url.searchParams.get('runValue') === 'A-1042'
        );
      });
      await valueFilter.getByRole('button', { name: 'Find runs' }).click();
      await request;
      await expect(page).toHaveURL(/runValueKey=orderId/);
      await expect(
        page.getByRole('button', { name: 'Remove filter orderId = A-1042' }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`run-value-filter-${theme}-${String(width)}.png`),
        fullPage: true,
      });
      await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);
      await expect(
        page.getByText('Saved run values', { exact: true }),
      ).toBeVisible();
      await expect(page.getByText('A-1042', { exact: true })).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Copy orderId' }),
      ).toBeVisible();
      await expect(page.getByText('Empty text', { exact: true })).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(
          `run-values-detail-${theme}-${String(width)}.png`,
        ),
        fullPage: true,
      });
    });
