import { expect, test } from '../support/fixtures';
import {
  firstRunId,
  installRoutes,
  run,
  timestamp,
  workspaceId,
} from './fixture';

for (const width of [375, 1280])
  for (const status of ['failed', 'timed_out'] as const)
    test(`keeps the safe ${status} step explanation visible at ${String(width)}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await installRoutes(page);
      const summary =
        'Add the required Authorization header before sending this request.';
      const base = `**/v1/workspaces/${workspaceId}/runs/${firstRunId}`;
      await page.route(base, (route) =>
        route.fulfill({
          json: {
            run: { ...run(firstRunId, 'failed'), status },
            nodes: [
              {
                id: '22222222-2222-4222-8222-222222222222',
                nodeId: 'calculate',
                invocationKey: 'calculate:0',
                status,
                currentAttemptNumber: 1,
                startedAt: timestamp,
                completedAt: '2026-09-15T10:00:01.000Z',
                resumeAt: null,
                safeErrorCode: 'execution.attempt_invalid',
                errorSummary: summary,
              },
            ],
          },
        }),
      );
      for (const kind of ['input', 'output'])
        await page.route(`${base}/node-runs/*/${kind}`, (route) =>
          route.fulfill({ json: { [kind]: { kind: 'none' } } }),
        );
      await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);
      if (width === 375)
        await expect(
          page
            .getByRole('region', { name: 'Why calculate failed' })
            .getByText(summary),
        ).toBeVisible();
      else {
        await page
          .getByRole('button', { name: /calculate:/u })
          .first()
          .click();
        await expect(
          page.getByLabel('Step details').getByText(summary),
        ).toBeVisible();
      }
    });
