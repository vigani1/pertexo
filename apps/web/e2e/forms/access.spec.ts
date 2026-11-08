import { test, expect } from '../support/fixtures';
import { openStepSetup } from '../../test/support/browser/steps';
import { platformBrowserNodeDefinitionCatalog } from '../../../../packages/node-catalog/dist/index.js';
import { nodeDefinitionListResponseSchema } from '@pertexo/contracts';
import { formConfigSchema } from '@pertexo/workflow-model';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workspaceId,
  workflowId,
} from '../workflow-editor/support';
const definitions = nodeDefinitionListResponseSchema.parse({
  items: platformBrowserNodeDefinitionCatalog().definitions,
}).items;
for (const width of [375, 1280])
  test(`retrieves and regenerates a public form link at ${String(width)}px`, async ({
    page,
    context,
  }, info) => {
    await page.setViewportSize({ width, height: 850 });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await addCsrfCookie(context);
    const remote = remoteDraft({
      settings: {},
      edges: [],
      nodes: [
        {
          id: 'form',
          label: 'Contact',
          definition: { key: 'core.form', version: 1 },
          configVersion: 1,
          config: formConfigSchema.parse({ title: 'Contact' }),
          position: { x: 80, y: 80 },
          inputMappings: {},
          connectionRefs: {},
        },
      ],
    });
    await installEditorRoutes(page, remote, { definitions });
    const publicId = '11111111-1111-4111-8111-111111111111';
    let capability = 'a'.repeat(43);
    let revision = 2;
    let writes = 0;
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/form/access`,
      async (route) => {
        if (route.request().method() === 'POST') {
          capability = (
            route.request().postDataJSON() as { capability: string }
          ).capability;
          revision++;
          writes++;
          return route.fulfill({
            json: { access: 'public', publicId, revision },
          });
        }
        return route.fulfill({
          json: { access: 'public', publicId, revision, capability },
        });
      },
    );
    await page.goto(editorUrl);
    await openStepSetup(page, { nodeId: 'form', width });
    const link = page.getByLabel('Public form link', { exact: true });
    await expect(link).toHaveValue(new RegExp(`#${capability}$`, 'u'));
    await expect(
      page.getByRole('img', { name: 'Public form QR code' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Copy form link' }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(await link.inputValue());
    await page
      .getByRole('button', { name: 'Regenerate link', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toContainText('pages and QR codes');
    expect(writes).toBe(0);
    await page
      .getByRole('button', { name: 'Regenerate and invalidate old link' })
      .click();
    await expect.poll(() => writes).toBe(1);
    await expect(link).toHaveValue(new RegExp(`#${capability}$`, 'u'));
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page
      .getByRole('img', { name: 'Public form QR code' })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`form-link-${String(width)}.png`),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.reload();
    await openStepSetup(page, { nodeId: 'form', width });
    await expect(
      page.getByLabel('Public form link', { exact: true }),
    ).toHaveValue(new RegExp(`#${capability}$`, 'u'));
  });
