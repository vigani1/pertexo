import { nodeDefinitionListResponseSchema } from '@pertexo/contracts';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import { platformBrowserNodeDefinitionCatalog } from '../../../../../packages/node-catalog/dist/index.js';
import { openStepSetup } from '../../../test/support/browser/steps';
import { expect, test } from '../../support/fixtures';
import { addStep } from '../actions';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
} from '../support';

const definitions = nodeDefinitionListResponseSchema.parse({
  items: platformBrowserNodeDefinitionCatalog().definitions,
}).items;

// Date's setup is drawn from its catalog schema: the operation choice, its
// words and each operation's starting values all come from there.
for (const width of [1280, 375])
  test(`adds a Date step from its schema and keeps the stored setup at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await addCsrfCookie(context);
    const remote = remoteDraft();
    const saved = () => parseWorkflowGraphDraft(remote.graph).nodes[0];
    await installEditorRoutes(page, remote, { definitions });
    await page.goto(editorUrl);
    if (width < 1024)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Add step', exact: true })
        .click();
    await addStep(page, /Convert date/u).click();
    await expect.poll(() => saved()?.config).toEqual({ operation: 'to_iso' });
    const id = saved()?.id ?? '';
    await openStepSetup(page, { nodeId: id, width });
    const operation = page.getByRole('combobox', {
      name: 'Date operation',
      exact: true,
    });
    await expect(operation).toHaveText('ISO timestamp (UTC)');
    await operation.click();
    await page
      .getByRole('option', { name: 'Format timestamp', exact: true })
      .click();
    // Today's builder started Format with these exact values.
    await expect
      .poll(() => saved()?.config)
      .toEqual({ operation: 'format', format: 'date_only', timeZone: 'UTC' });
    await expect(
      page.getByRole('combobox', { name: 'Format', exact: true }),
    ).toHaveText('Date only (YYYY-MM-DD)');
    const zone = page.getByRole('textbox', { name: 'Time zone', exact: true });
    await zone.fill('Europe/Paris');
    await zone.blur();
    await operation.click();
    await page
      .getByRole('option', { name: 'Convert time zone', exact: true })
      .click();
    // The time zone is shared, so it stays; Format's own setting goes.
    await expect
      .poll(() => saved()?.config)
      .toEqual({ operation: 'convert_timezone', timeZone: 'Europe/Paris' });
    await page.reload();
    await openStepSetup(page, { nodeId: id, width });
    await expect(
      page.getByRole('combobox', { name: 'Date operation', exact: true }),
    ).toHaveText('Convert time zone');
    await expect(
      page.getByRole('textbox', { name: 'Time zone', exact: true }),
    ).toHaveValue('Europe/Paris');
    expect(saved()?.config).toEqual({
      operation: 'convert_timezone',
      timeZone: 'Europe/Paris',
    });
  });
