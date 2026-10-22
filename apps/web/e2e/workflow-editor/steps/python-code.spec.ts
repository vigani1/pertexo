import { expect, test } from '../../support/fixtures';
import { platformBrowserNodeDefinitionCatalog } from '../../../../../packages/node-catalog/dist/index.js';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import { DEFAULT_CODE_SETTINGS } from '@pertexo/node-sdk';
import { nodeDefinitionListResponseSchema } from '@pertexo/contracts';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
} from '../support';

const definitions = nodeDefinitionListResponseSchema.parse({
  items: platformBrowserNodeDefinitionCatalog().definitions,
}).items;
for (const theme of ['light', 'dark'] as const)
  for (const width of [375, 990, 1440])
    test(`authors Python Code in ${theme} at ${String(width)}px without executing during syntax checks`, async ({
      page,
      context,
    }, info) => {
      await page.setViewportSize({ width, height: 800 });
      await page.addInitScript((theme) => {
        localStorage.setItem('pertexo.appearance', theme);
      }, theme);
      await addCsrfCookie(context);
      const remote = remoteDraft({
        nodes: [
          {
            id: 'code',
            label: 'Calculate',
            definition: { key: 'core.code', version: 1 },
            configVersion: 1,
            config: { code: 'return input;' },
            inputMappings: {},
            connectionRefs: {},
            position: { x: 80, y: 80 },
          },
        ],
        edges: [],
        settings: {},
      });
      await installEditorRoutes(page, remote, { definitions });
      await page.route('**/v1/node-definitions', (route) =>
        route.fulfill({
          json: { items: definitions, codeSettings: DEFAULT_CODE_SETTINGS },
        }),
      );
      let executions = 0;
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          /\/(?:previews|runs|tests)(?:\/|$)/u.test(
            new URL(request.url()).pathname,
          )
        )
          executions++;
      });
      await page.goto(editorUrl);
      await page.getByTestId('rf__node-code').click();
      if (width < 1024)
        await page
          .getByRole('navigation', { name: 'Editor panels' })
          .getByRole('button', { name: 'Step', exact: true })
          .click();
      await page.getByRole('tab', { name: 'Setup', exact: true }).click();
      const language = page.getByRole('combobox', {
        name: 'Language',
        exact: true,
      });
      await language.click();
      await page.getByRole('option', { name: 'Python', exact: true }).click();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(
        page.getByRole('textbox', { name: 'JavaScript', exact: true }),
      ).toContainText('return input;');
      await language.click();
      await page.getByRole('option', { name: 'Python', exact: true }).click();
      await page
        .getByRole('button', { name: 'Switch language', exact: true })
        .click();
      const editor = page.getByRole('textbox', { name: 'Python', exact: true });
      await expect(editor).toContainText('return input;');
      await editor.fill('return (');
      await expect(editor).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByText(/Check Python syntax here/u)).toBeVisible();
      const source =
        'import statistics\nreturn {"average": statistics.mean(input["values"]), "rate": _vars["RATE"]}';
      await editor.fill(source);
      await expect(editor).toHaveAttribute('aria-invalid', 'false');
      await expect
        .poll(() => parseWorkflowGraphDraft(remote.graph).nodes[0]?.config)
        .toEqual({ code: source, language: 'python' });
      await language.scrollIntoViewIfNeeded();
      await editor.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: info.outputPath(`python-code-${theme}-${String(width)}.png`),
        fullPage: true,
      });
      await editor.focus();
      await page.keyboard.press('Tab');
      await expect(editor).not.toBeFocused();
      expect(executions).toBe(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    });
