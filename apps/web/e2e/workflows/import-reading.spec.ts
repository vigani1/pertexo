import { expect, test } from '../support/fixtures';
import {
  addCsrfCookie,
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
} from '../workflow-editor/support';

for (const width of [375, 1280]) {
  test(`keeps the import name and finishes a held file read at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await addCsrfCookie(context);
    await installEditorRoutes(
      page,
      remoteDraft({ nodes: [], edges: [], settings: {} }),
      {
        accessibleWorkspace: {
          ...workspace,
          capabilities: [...workspace.capabilities, 'workflow:create'],
        },
      },
    );
    await page.goto(`/w/${workspaceId}/workflows`);
    await page.getByRole('button', { name: 'Import workflow…' }).click();
    await page.evaluate(() => {
      File.prototype.arrayBuffer = async function () {
        await new Promise<void>((resolve) => {
          window.addEventListener(
            'release-file-read',
            () => {
              resolve();
            },
            {
              once: true,
            },
          );
        });
        return new Blob([this]).arrayBuffer();
      };
    });
    const manifest = {
      format: 'pertexo.workflow',
      graph: { nodes: [], edges: [], settings: {} },
      requirements: { definitions: [] },
      connectionSlots: [],
    };
    await page.getByLabel('Workflow JSON file').setInputFiles({
      name: 'portable.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(manifest)),
    });
    await page.getByLabel('New workflow name').fill('My imported workflow');
    await page.evaluate(() =>
      window.dispatchEvent(new Event('release-file-read')),
    );
    await expect(page.getByLabel('Complete imported graph')).toBeAttached();
    await expect(page.getByLabel('New workflow name')).toHaveValue(
      'My imported workflow',
    );
    await expect(
      page.getByRole('button', { name: 'Preview import' }),
    ).toBeEnabled();
    await expect(page).toHaveURL(`/w/${workspaceId}/workflows`);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
