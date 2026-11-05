import { expect, test } from '../support/fixtures';
import {
  firstRunId,
  installRoutes,
  run,
  timestamp,
  workspaceId,
} from './fixture';

for (const width of [1280, 375])
  for (const [code, reason, remedy] of [
    [
      'http.response_encoding',
      /unsupported or invalid text encoding/u,
      /Correct the service’s response encoding/u,
    ],
    [
      'http.response_redaction_limit',
      /credential masking work limit/u,
      /smaller or less heavily escaped response/u,
    ],
  ] as const)
    test(`explains ${code} without setup advice at ${String(width)}px`, async ({
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
                  nodeId: 'http',
                  invocationKey: 'http:0',
                  status: 'failed',
                  currentAttemptNumber: 1,
                  startedAt: timestamp,
                  completedAt: '2026-09-15T10:00:01.000Z',
                  resumeAt: null,
                  safeErrorCode: code,
                },
              ],
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
      await page
        .getByRole('button', { name: /http: Failed/u })
        .first()
        .click();
      const details =
        width < 640
          ? page.getByRole('dialog')
          : page.getByLabel('Step details');
      await expect(details.getByText(reason)).toBeVisible();
      await expect(details.getByText(/not kept/u)).toBeVisible();
      await expect(details.getByText(remedy)).toBeVisible();
      await expect(
        details.getByText(/Check its settings in Build/u),
      ).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath('response-refusal.png'),
        fullPage: true,
      });
    });
