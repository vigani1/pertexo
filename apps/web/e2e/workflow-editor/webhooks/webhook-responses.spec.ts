import { expect, test } from '../../support/fixtures';
import { platformBrowserNodeDefinitionCatalog } from '../../../../../packages/node-catalog/dist/index.js';
import {
  nodeDefinitionListResponseSchema,
  workflowGraphSchema,
} from '@pertexo/contracts';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
} from '../support';
const definitions = nodeDefinitionListResponseSchema.parse({
  items: platformBrowserNodeDefinitionCatalog().definitions,
}).items;
for (const width of [375, 1280]) {
  test(`keeps opt-in webhook replies plain, mapped and bounded at ${String(width)}px`, async ({
    page,
    context,
  }, info) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await addCsrfCookie(context);
    const node = (
      id: string,
      key: string,
      config: Record<string, unknown>,
      x: number,
    ) => ({
      id,
      label: id,
      definition: { key, version: 1 },
      configVersion: 1,
      config,
      inputMappings: {},
      connectionRefs: {},
      position: { x, y: 0 },
    });
    const remote = remoteDraft({
      nodes: [
        node('incoming', 'core.webhook', {}, 40),
        node('respond', 'core.respond_webhook', { bodyType: 'json' }, 400),
      ],
      edges: [
        {
          id: 'reply-link',
          source: { nodeId: 'incoming', port: 'out' },
          target: { nodeId: 'respond', port: 'in' },
        },
      ],
      settings: {},
    });
    await installEditorRoutes(page, remote, { definitions });
    await page.goto(editorUrl);
    await page.getByTestId('rf__node-incoming').focus();
    await page.keyboard.press('Enter');
    if (width < 1024)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Step', exact: true })
        .click();
    const mode = page.getByLabel('Respond to caller', { exact: true });
    await expect(mode).toContainText('Immediately (202)');
    await expect(
      page.getByLabel('Wait time (seconds)', { exact: true }),
    ).toHaveCount(0);
    await mode.click();
    await page
      .getByRole('option', { name: 'When the workflow responds', exact: true })
      .click();
    const seconds = page.getByLabel('Wait time (seconds)', { exact: true });
    await expect(seconds).toHaveValue('10');
    await seconds.fill('30');
    await page.keyboard.press('Tab');
    await expect
      .poll(() => workflowGraphSchema.parse(remote.graph).nodes[0]?.config)
      .toEqual({ responseMode: 'workflow', responseWaitSeconds: 30 });
    await page.screenshot({
      path: info.outputPath(`webhook-wait-${String(width)}.png`),
    });
    await page.getByTestId('rf__node-respond').focus();
    await page.keyboard.press('Enter');
    await page.getByLabel('Response body', { exact: true }).click();
    await page.getByRole('option', { name: 'Plain text', exact: true }).click();
    await expect
      .poll(() => workflowGraphSchema.parse(remote.graph).nodes[1]?.config)
      .toEqual({ bodyType: 'text' });
    await expect(
      page.getByText('The first response wins and the workflow continues.', {
        exact: false,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`webhook-response-${String(width)}.png`),
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
    await page.getByRole('button', { name: 'Add input', exact: true }).click();
    const row = page
      .getByRole('region', { name: 'Inputs', exact: true })
      .locator('ol > li')
      .last();
    await row.getByLabel('Field', { exact: true }).fill('body');
    await row.getByRole('button', { name: 'Run input', exact: true }).click();
    await row.getByLabel('Run input path', { exact: true }).fill('$.reply');
    await page.keyboard.press('Tab');
    await expect
      .poll(
        () => workflowGraphSchema.parse(remote.graph).nodes[1]?.inputMappings,
      )
      .toEqual({ body: { kind: 'run_input', path: '$.reply' } });
  });
}
