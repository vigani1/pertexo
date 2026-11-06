import { expect, test } from '../support/fixtures';
import {
  firstRunId,
  installRoutes,
  run,
  timestamp,
  workspaceId,
} from './fixture';

for (const width of [1280, 375])
  for (const [dimension, summary] of [
    [
      'source',
      'Expression for field "total" exceeded the source size limit of 16384 bytes. Shorten the expression or split the calculation into steps.',
    ],
    [
      'input',
      'Expression for field "total" exceeded the input size limit of 1048576 bytes. Pass less data to the expression.',
    ],
    [
      'memory',
      'Expression for field "total" exceeded the heap memory limit of 64 MiB. Work on less data or split the calculation into steps.',
    ],
  ] as const)
    test(`shows the specific ${dimension} mapping refusal and useful advice at ${String(width)}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await installRoutes(page);
      await page.route(
        `**/v1/workspaces/${workspaceId}/runs/${firstRunId}`,
        (route) =>
          route.fulfill({
            json: {
              run: run(firstRunId, 'failed'),
              nodes: [
                {
                  id: '22222222-2222-4222-8222-222222222222',
                  nodeId: 'calculate',
                  invocationKey: 'calculate:0',
                  status: 'failed',
                  currentAttemptNumber: 1,
                  startedAt: timestamp,
                  completedAt: '2026-09-15T10:00:01.000Z',
                  resumeAt: null,
                  safeErrorCode: 'execution.expression_limit_exceeded',
                  errorSummary: summary,
                },
              ],
            },
          }),
      );
      for (const kind of ['input', 'output'])
        await page.route(
          `**/v1/workspaces/${workspaceId}/runs/${firstRunId}/node-runs/*/${kind}`,
          (route) => route.fulfill({ json: { [kind]: { kind: 'none' } } }),
        );
      await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);
      await page
        .getByRole('button', { name: /calculate: Failed/u })
        .first()
        .click();
      const details =
        width < 640
          ? page.getByRole('dialog')
          : page.getByLabel('Step details');
      await expect(details.getByText(summary, { exact: true })).toBeVisible();
      await expect(
        details.getByText(
          'Review the specific limit in the step’s error. Simplify the expression or reduce the data it reads or returns, publish, then replay the run.',
        ),
      ).toBeVisible();
      await expect(
        details.getByText('execution.expression_limit_exceeded', {
          exact: true,
        }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath('mapping-diagnostic.png'),
        fullPage: true,
      });
    });
