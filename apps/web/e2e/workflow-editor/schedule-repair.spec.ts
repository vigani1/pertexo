import { expect, test } from '../support/fixtures';
import {
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workflowSummary,
  workspaceId,
} from './support';

test('renders the repair action when schedule health has no valid recurrence', async ({
  page,
}, testInfo) => {
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
  await installEditorRoutes(page, remoteDraft());
  const path = `/v1/workspaces/${workspaceId}/workflows/${workflowId}`;
  const versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const triggerId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  await page.route(`**${path}`, (route) =>
    route.fulfill({ json: workflowSummary('Schedule repair', versionId) }),
  );
  await page.route(`**${path}/versions?**`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(`**${path}/triggers`, (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route(`**${path}/triggers/schedules`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: triggerId,
            workflowId,
            workflowVersionId: versionId,
            nodeId: 'nightly',
            kind: 'schedule',
            status: 'active',
            healthStatus: 'unhealthy',
            lastErrorCode: 'schedule.recurrence_invalid',
            reconciledAt: '2026-09-14T10:00:00.000Z',
            recurrence: null,
            misfirePolicy: 'skip',
            nextFireAt: '2026-09-14T11:00:00.000Z',
            lastFireAt: null,
          },
        ],
      },
    }),
  );
  await page.route(
    `**${path}/triggers/${triggerId}/schedule/occurrences?**`,
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.goto(`${editorUrl}/triggers`);
  const card = page.getByRole('article', { name: /Schedule:/ });
  await expect(card.getByText('Schedule needs repair')).toBeVisible();
  await expect(
    card.getByText('Edit the schedule and publish again.', { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('schedule-repair.png'),
    fullPage: true,
  });
});
