import { expect, test } from '@playwright/test';
import {
  nativeCallGraph,
  workflowCallPin,
} from '../test/support/workflow-call-fixtures';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  mappingGraph,
  remoteDraft,
} from './workflow-editor-support';

test('authors, saves and reloads a callable contract without enabling native commands', async ({
  context,
  page,
}, testInfo) => {
  const remote = remoteDraft(mappingGraph());
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await page.goto(editorUrl);
  await page
    .getByRole('button', { name: 'Callable contract', exact: true })
    .click();
  await page.getByRole('button', { name: 'Add callable contract' }).click();
  const panel = page.getByRole('region', { name: 'Callable contract' });
  const descriptor =
    '{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}';
  await panel.getByLabel('Input type', { exact: true }).fill(descriptor);
  await panel.getByLabel('Result type', { exact: true }).fill(descriptor);
  await panel
    .getByLabel('Result source', { exact: true })
    .fill('{"kind":"run_input","path":"$"}');
  await expect(page.getByText(/^Saved/u)).toBeVisible();
  expect(remote.graph).toMatchObject({
    schemaVersion: 2,
    callable: {
      input: { required: ['name'] },
      result: { required: ['name'] },
      resultSelector: { kind: 'run_input', path: '$' },
    },
  });
  expect(remote.graph.nodes).toHaveLength(2);
  await expect(page.getByRole('button', { name: /^Publish/u })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Run/u })).toHaveCount(0);
  await page.reload();
  await page
    .getByRole('button', { name: 'Callable contract', exact: true })
    .click();
  expect(
    JSON.parse(
      await panel.getByLabel('Input type', { exact: true }).inputValue(),
    ),
  ).toMatchObject({ required: ['name'] });
  expect(
    JSON.parse(
      await panel.getByLabel('Result source', { exact: true }).inputValue(),
    ),
  ).toEqual({ kind: 'run_input', path: '$' });
  await panel.getByLabel('Result source', { exact: true }).fill('{');
  await panel.getByLabel('Input type', { exact: true }).click();
  await expect(
    panel.getByLabel('Result source', { exact: true }),
  ).toHaveAttribute('aria-invalid', 'true');
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Discard the unfinished edit?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stay', exact: true }).click();
  await panel.getByRole('button', { name: 'Discard unapplied text' }).click();
  await page.screenshot({
    path: testInfo.outputPath('callable-contract-desktop.png'),
  });
  await panel.getByRole('button', { name: 'Remove callable contract' }).click();
  await expect(page.getByText(/^Saved/u)).toBeVisible();
  expect(remote.graph.schemaVersion).toBe(2);
  expect(remote.graph).not.toHaveProperty('callable');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(
    panel.getByLabel('Result source', { exact: true }),
  ).toBeVisible();
});

test('keeps callable authoring accessible and bounded at phone width', async ({
  context,
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const remote = remoteDraft(mappingGraph());
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await page.goto(editorUrl);
  await page.getByRole('button', { name: 'More editor actions' }).click();
  await page.getByRole('menuitem', { name: 'Callable contract' }).click();
  await page.getByRole('button', { name: 'Add callable contract' }).click();
  const panel = page.getByRole('region', { name: 'Callable contract' });
  await expect(panel.getByLabel('Input type', { exact: true })).toBeVisible();
  await panel
    .getByLabel('Result source', { exact: true })
    .fill('{"kind":"literal","value":{}}');
  await expect(page.getByText(/^Saved/u)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('callable-contract-mobile.png'),
  });
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel).toBeHidden();
});

test('edits and reloads an exact Call pin while native execution stays unavailable', async ({
  context,
  page,
}, testInfo) => {
  const graph = nativeCallGraph();
  const remote = remoteDraft({ ...graph, settings: { ...graph.settings } });
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await page.goto(editorUrl);
  await page.getByTestId('rf__node-call').click();
  await expect(
    page.getByLabel('Child workflow ID', { exact: true }),
  ).toHaveValue(workflowCallPin.workflowId);
  const version = page.getByLabel('Pinned version ID', { exact: true });
  await version.fill('latest');
  await page.getByLabel('Child workflow ID', { exact: true }).click();
  await expect(version).toHaveAttribute('aria-invalid', 'true');
  await expect(
    page.getByRole('button', { name: 'Edit as JSON' }),
  ).toBeDisabled();
  expect(remote.graph.nodes[0]).toMatchObject({ config: workflowCallPin });
  const nextId = '33333333-3333-4333-8333-333333333333';
  await version.fill(nextId);
  await expect(page.getByText(/^Saved/u)).toBeVisible();
  expect(remote.graph.nodes[0]).toMatchObject({
    config: { ...workflowCallPin, versionId: nextId },
    inputMappings: { name: { kind: 'run_input', path: '$.name' } },
  });
  await page.reload();
  await page.getByTestId('rf__node-call').click();
  await expect(
    page.getByLabel('Pinned version ID', { exact: true }),
  ).toHaveValue(nextId);
  await page.screenshot({ path: testInfo.outputPath('call-pin-desktop.png') });
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  await expect(
    page.getByText('Native step testing and execution are not enabled.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^Publish/u })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Run/u })).toHaveCount(0);
});
