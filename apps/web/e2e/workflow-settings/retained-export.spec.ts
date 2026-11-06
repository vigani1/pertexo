import { readFile } from 'node:fs/promises';
import { expect, test } from '../support/fixtures';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workflowSummary,
  workspace,
  workspaceId,
} from '../workflow-editor/support';

for (const width of [1280, 375]) {
  for (const status of ['active', 'suspended'] as const) {
    test(`exports an archived retained version in a ${status} workspace at ${String(width)}px`, async ({
      page,
      context,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await addCsrfCookie(context);
      const graph = { nodes: [], edges: [], settings: {} };
      await installEditorRoutes(page, remoteDraft(graph), {
        accessibleWorkspace: {
          ...workspace,
          status,
          capabilities: ['workspace:read', 'workflow:read'],
        },
      });
      const base = `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`;
      const versionId = '77777777-7777-4777-8777-777777777777';
      await page.route(base, (route) =>
        route.fulfill({
          json: {
            workflow: {
              ...workflowSummary('Retained workflow', versionId).workflow,
              lifecycleStatus: 'archived',
            },
          },
        }),
      );
      await page.route(`${base}/versions?*`, (route) =>
        route.fulfill({
          json: {
            items: [
              {
                id: versionId,
                workflowId,
                versionNumber: 1,
                graph,
                checksum: `wf:sha256:${'a'.repeat(64)}`,
                publishedAt: '2026-09-14T10:00:00.000Z',
              },
            ],
            nextCursor: null,
          },
        }),
      );
      const manifest = {
        format: 'pertexo.workflow',
        graph,
        requirements: { definitions: [] },
        connectionSlots: [],
      };
      await page.route(`${base}/export`, (route) => {
        expect(route.request().postDataJSON()).toMatchObject({
          source: { kind: 'version', versionId },
        });
        return route.fulfill({ json: manifest });
      });
      await page.goto(`${editorUrl}/versions`);
      await page.getByRole('button', { name: 'More for v1' }).click();
      await page.getByRole('menuitem', { name: /Export/u }).click();
      const dialog = page.getByRole('dialog', { name: /Export/u });
      await expect(
        dialog.getByLabel('Complete saved source graph'),
      ).toBeVisible();
      await expect(dialog).toContainText(
        'Exports v1 exactly as it was published',
      );
      await dialog.getByRole('checkbox').check();
      await page.screenshot({
        path: info.outputPath('retained-export.png'),
        fullPage: true,
      });
      const downloaded = page.waitForEvent('download');
      await dialog
        .getByRole('button', { name: 'Download workflow JSON' })
        .click();
      const download = await downloaded;
      expect(download.suggestedFilename()).toBe('pertexo-workflow.json');
      const path = await download.path();
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(manifest);
      await expect(dialog).not.toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Restore to draft' }),
      ).toHaveCount(0);
    });
  }
}
