import { expect, test } from '../../support/fixtures';
import { openWorkflowAction } from '../actions';
import { mappingGraph } from '../graph';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workflowSummary,
  workspaceId,
} from '../support';

for (const activation of ['pointer', 'keyboard'] as const) {
  test(`keeps the ${activation} Run menu open when input cases finishes closing`, async ({
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
    await page
      .getByRole('dialog', { name: 'Input cases', exact: true })
      .getByRole('button', { name: 'Close input cases' })
      .press('Enter');
    await expect(
      page.getByRole('button', { name: 'More workflow actions' }),
    ).toBeFocused();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await openWorkflowAction(page, 'Input cases');
      const dialog = page.getByRole('dialog', {
        name: 'Input cases',
        exact: true,
      });
      await expect(dialog).toBeVisible();
      const closingDialog = await dialog.elementHandle();
      await dialog.getByRole('button', { name: 'Close input cases' }).click();
      const run = page.getByRole('button', { name: 'Run', exact: true });
      if (activation === 'pointer') await run.click();
      else await run.press('Enter');
      const item = page.getByRole('menuitem', {
        name: 'Run with input…',
        exact: true,
      });
      await expect(item).toBeVisible({ timeout: 3000 });
      const original = await item.elementHandle();
      await expect
        .poll(() => closingDialog.evaluate((element) => element.isConnected))
        .toBe(false);
      expect(await original.evaluate((element) => element.isConnected)).toBe(
        true,
      );
      await item.click({ timeout: 3000 });
      const runDialog = page.getByRole('dialog', {
        name: 'Run with input',
        exact: true,
      });
      await expect(runDialog).toBeVisible();
      await runDialog
        .getByRole('button', { name: 'Cancel', exact: true })
        .click();
    }
  });
}
