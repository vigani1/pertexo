import { expect, test } from '../support/fixtures';
import { firstRunId, installRoutes, run, workspaceId } from './fixture';

test('explains a run-level failure in history and on the retained run', async ({
  page,
}, testInfo) => {
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
  await installRoutes(page);
  const failed = {
    ...run(firstRunId, 'failed'),
    failureReasonCode: 'execution.run_state_invalid',
  };
  const base = `/v1/workspaces/${workspaceId}/runs`;
  await page.route(`**${base}?**`, (route) =>
    route.fulfill({
      json: { items: [{ ...failed, failedStep: null }], nextCursor: null },
    }),
  );
  await page.route(`**${base}/${firstRunId}`, (route) =>
    route.fulfill({ json: { run: failed, nodes: [] } }),
  );
  await page.goto(`/w/${workspaceId}/runs`);
  await expect(
    page.getByText(/saved execution state is invalid/),
  ).toBeVisible();
  await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);
  await expect(
    page.getByText(/saved execution state is invalid/).first(),
  ).toBeVisible();
  await expect(
    page.getByText(/No failed step can safely be retried using saved results/),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Retry from this step', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('execution.run_state_invalid', { exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('run-level-failure.png'),
    fullPage: true,
  });
});
