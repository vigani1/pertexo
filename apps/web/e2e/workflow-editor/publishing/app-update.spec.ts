import { platformBrowserNodeDefinitionCatalog } from '../../../../../packages/node-catalog/dist/index.js';
import { expect, test, type Page } from '../../support/fixtures';
import { blocksUnload } from '../actions';
import {
  addCsrfCookie,
  definition,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workspaceId,
} from '../support';

const codeDefinition = platformBrowserNodeDefinitionCatalog().definitions.find(
  ({ definition: identity }) =>
    identity.key === 'core.code' && identity.version === 1,
);
if (codeDefinition === undefined)
  throw new Error('Code definition is required');

const setAndCode = {
  nodes: [
    {
      id: 'node-set',
      label: 'Tag order',
      definition: { key: 'core.set', version: 1 },
      position: { x: 80, y: 80 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
    },
    {
      id: 'node-code',
      label: 'Shape order',
      definition: { key: 'core.code', version: 1 },
      position: { x: 80, y: 480 },
      configVersion: 1,
      config: { code: 'return input;' },
      inputMappings: {},
      connectionRefs: {},
    },
  ],
  edges: [],
  settings: {},
};

/** A deployment replaces every hashed file; the old tab's chunks now 404. */
async function deployNewVersion(page: Page) {
  await page.route('**/assets/**', (route) => route.fulfill({ status: 404 }));
}

/** Marks this document, so a reload (which replaces it) is visible. */
async function markDocument(page: Page) {
  await page.evaluate(() => {
    document.documentElement.dataset.beforeDeployment = 'true';
  });
}

function documentIsUnchanged(page: Page) {
  return page.evaluate(
    () => document.documentElement.dataset.beforeDeployment === 'true',
  );
}

function step(page: Page, label: string) {
  return page.locator('.react-flow__node').filter({ hasText: label });
}

test('keeps an unsaved editor when a step setup was removed by a deployment', async ({
  context,
  page,
}) => {
  await addCsrfCookie(context);
  await installEditorRoutes(page, remoteDraft(setAndCode), {
    definitions: [definition, codeDefinition],
  });
  // Saves fail, so the edit below stays unsaved for the whole test.
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
    (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({
            status: 503,
            contentType: 'application/problem+json',
            body: JSON.stringify({ title: 'Unavailable', status: 503 }),
          })
        : route.fallback(),
  );
  await page.goto(editorUrl);
  await step(page, 'Tag order').click();
  await page.getByLabel('Value', { exact: true }).fill('reviewed');
  await expect.poll(() => blocksUnload(page)).toBe(true);
  await markDocument(page);

  await deployNewVersion(page);
  await step(page, 'Shape order').click();
  await expect(
    page.getByText('Pertexo was updated. Reload to continue.'),
  ).toBeVisible();

  // Reload asks first, because the editor still holds the unsaved edit.
  const prompts: string[] = [];
  page.once('dialog', (prompt) => {
    prompts.push(prompt.type());
    void prompt.dismiss();
  });
  await page.getByRole('button', { name: 'Reload' }).click();
  expect(prompts).toEqual(['beforeunload']);

  // The same page, still holding the edit.
  expect(await documentIsUnchanged(page)).toBe(true);
  expect(await blocksUnload(page)).toBe(true);
});

test('shows the update page for a route removed by a deployment, without reloading', async ({
  context,
  page,
}) => {
  await addCsrfCookie(context);
  await installEditorRoutes(page, remoteDraft(setAndCode));
  await page.goto(editorUrl);
  await expect(step(page, 'Tag order')).toBeVisible();
  await markDocument(page);

  await deployNewVersion(page);
  await page.getByRole('link', { name: 'Back to workflows' }).click();

  await expect(
    page.getByRole('heading', { name: 'Pertexo was updated' }),
  ).toBeVisible();
  await expect(page.getByText('Reload to continue.')).toBeVisible();
  await expect(page).toHaveURL(`/w/${workspaceId}/workflows`);
  expect(await documentIsUnchanged(page)).toBe(true);
});
