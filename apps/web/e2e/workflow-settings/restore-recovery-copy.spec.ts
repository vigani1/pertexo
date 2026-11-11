import { workflowVersionsBody } from '../workflows/read-projections';
import { expect, test } from '../support/fixtures';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workspaceId,
} from '../workflow-editor/support';

for (const width of [1280, 375]) {
  for (const lostResponse of [false, true]) {
    test(`restoring a version explains and links the recovery copy at ${String(width)}px, lost response ${String(lostResponse)}`, async ({
      page,
      context,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await addCsrfCookie(context);
      const remote = remoteDraft({
        nodes: [],
        edges: [],
        settings: { maxRunDurationMs: 2_000 },
      });
      await installEditorRoutes(page, remote);
      const versionId = '77777777-7777-4777-8777-777777777777';
      const recoveryCopyId = '88888888-8888-4888-8888-888888888888';
      const graph = { nodes: [], edges: [], settings: {} };
      const base = `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`;
      await page.route(`${base}/versions?*`, async (route) =>
        route.fulfill({
          json: await workflowVersionsBody(route.request().url(), {
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
          }),
        }),
      );
      const keys: string[] = [];
      await page.route(`${base}/versions/${versionId}/restore`, (route) => {
        keys.push(route.request().headers()['idempotency-key'] ?? '');
        expect(route.request().headers()['if-match']).toMatch(
          /^"draft\.[A-Za-z0-9_-]{43}"$/u,
        );
        if (keys.length === 1) {
          remote.graph = graph;
          remote.revision += 1;
          if (lostResponse) return route.abort('failed');
        }
        return route.fulfill({
          headers: { etag: `"draft.${'b'.repeat(43)}"` },
          json: {
            workflowId,
            revision: remote.revision,
            graph,
            updatedAt: '2026-09-14T10:01:00.000Z',
            compatibility: {
              compatible: true,
              fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
              issues: [],
            },
            recoveryCopyId,
          },
        });
      });
      await page.goto(`${editorUrl}/versions`);
      await page.getByRole('button', { name: 'Restore to draft' }).click();
      const dialog = page.getByRole('dialog', {
        name: 'Restore v1 to the draft?',
      });
      await expect(dialog).toContainText(
        'Unpublished changes will be saved as a separate disabled copy in the same folder.',
      );
      await dialog.getByRole('button', { name: 'Restore to draft' }).click();
      await expect(
        page.getByText('Your unpublished changes were saved as a copy:'),
      ).toBeVisible();
      await expect(
        page.getByRole('link', { name: 'Open copy' }),
      ).toHaveAttribute(
        'href',
        `/w/${workspaceId}/workflows/${recoveryCopyId}`,
      );
      expect(keys).toHaveLength(lostResponse ? 2 : 1);
      expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/u);
      expect(new Set(keys).size).toBe(1);
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: info.outputPath('recovery-copy.png'),
        fullPage: true,
      });
    });
  }
}
