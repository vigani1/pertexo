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

test.use({ viewport: { width: 1280, height: 900 } });

test('Classify saves normalized category names and rejects duplicates on the edited row', async ({
  page,
  context,
}) => {
  await addCsrfCookie(context);
  const remote = remoteDraft();
  const saved = () => parseWorkflowGraphDraft(remote.graph).nodes[0];
  await installEditorRoutes(page, remote, { definitions });
  await page.goto(editorUrl);
  await (await addStep(page, /^Classify\b/u)).click();
  await expect.poll(() => saved()?.definition.key).toBe('ai.classify');
  await openStepSetup(page, { nodeId: saved()?.id ?? '', width: 1280 });
  const add = page.getByRole('button', { name: 'Add category', exact: true });
  await add.click();
  await add.click();
  const names = page.getByLabel('Category name', { exact: true });
  await names.nth(0).fill('  Billing  ');
  await names.nth(0).blur();
  await names.nth(1).fill('Access');
  await names.nth(1).blur();
  await expect
    .poll(() => saved()?.config.categories)
    .toMatchObject([{ label: 'Billing' }, { label: 'Access' }]);
  await names.nth(0).fill('  aCCESS ');
  await names.nth(0).blur();
  await expect(page.getByText('Use a unique category name.')).toBeVisible();
  expect(saved()?.config.categories).toMatchObject([
    { label: 'Billing' },
    { label: 'Access' },
  ]);
});

test('Guardrails reveals the required model setup only when a model check is enabled', async ({
  page,
  context,
}) => {
  await addCsrfCookie(context);
  const remote = remoteDraft();
  const saved = () => parseWorkflowGraphDraft(remote.graph).nodes[0];
  await installEditorRoutes(page, remote, { definitions });
  await page.goto(editorUrl);
  await (await addStep(page, /^Guardrails\b/u)).click();
  await expect.poll(() => saved()?.definition.key).toBe('ai.guardrails');
  await openStepSetup(page, { nodeId: saved()?.id ?? '', width: 1280 });
  const model = page.getByRole('checkbox', { name: 'Model check' });
  const connection = page.getByLabel('AI model connection', { exact: true });
  await expect(connection).toHaveCount(0);
  await model.check();
  await expect(connection).toBeVisible();
  await expect(
    page.getByText(/Choose an AI model connection to see the destination/u),
  ).toBeVisible();
  await model.uncheck();
  await expect(connection).toHaveCount(0);
  await expect.poll(() => saved()?.connectionRefs).toEqual({});
});
