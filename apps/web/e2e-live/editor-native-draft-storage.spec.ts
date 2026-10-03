import { expect } from '@playwright/test';
import { workflowDraftResponseSchema } from '@pertexo/contracts/schemas/workflow-authoring';
import { test } from './support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from './support/ordinary-editor-session';
import {
  addSingleStep,
  createEditorWorkflow,
  readEditorDraft,
} from './support/single-step-authoring';

test('saves native callable source through real HTTP and retains the full graph on full-page reload', async ({
  page,
  request,
}, info) => {
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Owned live fixture required');
  const forbiddenCommands: string[] = [];
  page.on('request', (sent) => {
    if (
      sent.method() === 'POST' &&
      /\/(?:publish|runs)(?:\?|$)/u.test(new URL(sent.url()).pathname)
    )
      forbiddenCommands.push(sent.url());
  });
  await registerEditorUser(
    page,
    request,
    mailOrigin,
    'Ordinary native draft author',
  );
  const workspaceId = await createEditorWorkspace(page, 'Owned native draft');
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Editable source only',
  );
  const nodeId = await addSingleStep(
    page,
    workflowPath,
    /Set fields/u,
    'Retained mapping source',
  );
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  const row = page
    .getByRole('region', { name: 'Inputs', exact: true })
    .locator('ol > li')
    .last();
  await row.getByLabel('Field', { exact: true }).fill('literalProof');
  await row
    .getByLabel('JSON value', { exact: true })
    .fill('"from-real-native-browser"');
  await page.keyboard.press('Tab');
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes[0]
          ?.inputMappings,
    )
    .toEqual({
      literalProof: { kind: 'literal', value: 'from-real-native-browser' },
    });
  const retained = await readEditorDraft(page, workflowPath);
  await page
    .getByRole('button', { name: 'Callable contract', exact: true })
    .click();
  await page.getByRole('button', { name: 'Add callable contract' }).click();
  const panel = page.getByRole('region', { name: 'Callable contract' });
  const descriptor = {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  };
  await panel
    .getByLabel('Input type', { exact: true })
    .fill(JSON.stringify(descriptor));
  await panel
    .getByLabel('Result type', { exact: true })
    .fill(JSON.stringify(descriptor));
  await panel.getByLabel('Result step shortcut', { exact: true }).click();
  await page
    .getByRole('option', { name: 'Retained mapping source', exact: true })
    .click();
  await panel.getByLabel('Input type', { exact: true }).click();
  const expected = {
    ...retained.graph,
    schemaVersion: 2,
    callable: {
      schemaVersion: 1,
      input: descriptor,
      result: descriptor,
      resultSelector: { kind: 'node_output', nodeId, path: '$' },
    },
  };
  await expect
    .poll(async () => (await readEditorDraft(page, workflowPath)).graph)
    .toEqual(expected);
  const savedResponse = await page.request.get(`${workflowPath}/draft`);
  expect(savedResponse.status()).toBe(200);
  const saved = workflowDraftResponseSchema.parse(await savedResponse.json());
  const tag = savedResponse.headers().etag;
  expect(tag).toMatch(/^"draft-v2\.[A-Za-z0-9_-]{43}"$/u);
  expect(saved.revision).toBeGreaterThan(retained.revision);
  await expect(page.getByRole('button', { name: /^Publish/u })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Run/u })).toHaveCount(0);
  const reloadRead = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === `${workflowPath}/draft`,
  );
  await page.reload();
  const reloadedResponse = await reloadRead;
  expect(reloadedResponse.status()).toBe(200);
  const reloaded = workflowDraftResponseSchema.parse(
    await reloadedResponse.json(),
  );
  expect(reloaded).toEqual(saved);
  expect(reloadedResponse.headers().etag).toBe(tag);
  await page
    .getByRole('button', { name: 'Callable contract', exact: true })
    .click();
  expect(
    JSON.parse(
      await panel.getByLabel('Input type', { exact: true }).inputValue(),
    ),
  ).toEqual(descriptor);
  expect(
    JSON.parse(
      await panel.getByLabel('Result type', { exact: true }).inputValue(),
    ),
  ).toEqual(descriptor);
  expect(
    JSON.parse(
      await panel.getByLabel('Result source', { exact: true }).inputValue(),
    ),
  ).toEqual(expected.callable.resultSelector);
  await expect(page.getByRole('button', { name: /^Publish/u })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Run/u })).toHaveCount(0);
  expect(forbiddenCommands).toEqual([]);
  console.info(
    'Ordinary native draft full-page reload evidence',
    JSON.stringify({
      workspaceId,
      workflowPath,
      revision: saved.revision,
      etag: tag,
      graph: reloaded.graph,
      fullPageReload: true,
      publishRunCommands: forbiddenCommands.length,
    }),
  );
  await page.screenshot({
    path: info.outputPath('native-draft-real-reload.png'),
  });
  await info.attach('ordinary-native-draft-source', {
    body: JSON.stringify({
      workspaceId,
      workflowPath,
      revision: saved.revision,
      etag: tag,
      graph: reloaded.graph,
      fullPageReload: true,
      commands: forbiddenCommands,
    }),
    contentType: 'application/json',
  });
});
