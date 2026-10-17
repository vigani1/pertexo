import { expect, test } from '../../support/fixtures';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  mappingGraph,
  openWorkflowAction,
  remoteDraft,
  workflowId,
  workflowSummary,
  workspaceId,
} from '../support';

test('keeps Run open when a closing input-cases dialog finishes', async ({
  context,
  page,
}) => {
  await addCsrfCookie(context);
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
  const remote = remoteDraft(mappingGraph());
  await installEditorRoutes(page, remote);
  const versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const root = `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`;
  await page.route(root, (route) =>
    route.fulfill({ json: workflowSummary('Run input', versionId) }),
  );
  await page.route(`${root}/versions?**`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: versionId,
            workflowId,
            versionNumber: 1,
            graph: remote.graph,
            checksum: `wf:sha256:${'a'.repeat(64)}`,
            publishedAt: '2026-10-01T12:00:00.000Z',
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.goto(editorUrl);
  await openWorkflowAction(page, 'Input cases');
  const dialog = page.getByRole('dialog', { name: 'Input cases', exact: true });
  await expect(dialog).toBeVisible();
  // Hold the real closing transition across the next user interaction.
  await dialog.evaluate((element) => {
    element.style.transitionDuration = '2s';
  });
  await dialog.getByRole('button', { name: 'Close input cases' }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).press('Enter');
  const item = page.getByRole('menuitem', {
    name: 'Run with input…',
    exact: true,
  });
  await expect(item).toBeVisible();
  const original = await item.elementHandle();
  await expect(dialog).toHaveCount(0);
  expect(await original.evaluate((element) => element.isConnected)).toBe(true);
  await item.click();
  await expect(
    page.getByRole('dialog', { name: 'Run with input', exact: true }),
  ).toBeVisible();
});
