import { readFile } from 'node:fs/promises';
import { expect, type Page, type Locator } from '@playwright/test';
import {
  workflowDraftResponseSchema,
  workflowTemplateOriginProjectionResponseSchema,
  workflowDuplicateResponseSchema,
} from '@pertexo/contracts';
import {
  parsePortableJson,
  workflowPortableManifestSchema,
} from '@pertexo/workflow-model';
import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';
import { test } from './support/browser-fixture';

interface Seed {
  workspaceId: string;
  destinationConnections: Record<string, string>;
  httpEndpoint: string;
  slackChannel: string;
  cookies: { name: string; value: string; url: string }[];
}

async function readOrigin(page: Page, workspaceId: string, workflowId: string) {
  const response = await page.request.get(
    `/v1/workspaces/${workspaceId}/workflows/${workflowId}?include=templateOrigin`,
  );
  expect(response.status()).toBe(200);
  return workflowTemplateOriginProjectionResponseSchema.parse(
    await response.json(),
  ).templateOrigin;
}

async function readDraft(page: Page, workspaceId: string, workflowId: string) {
  const response = await page.request.get(
    `/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
  );
  expect(response.status()).toBe(200);
  return workflowDraftResponseSchema.parse(await response.json());
}

async function importReviewedDraft(page: Page, dialog: Locator) {
  await dialog
    .getByRole('button', { name: 'Preview import', exact: true })
    .click();
  await expect(
    dialog.getByText(/Compatible with this workspace/u),
  ).toBeVisible();
  await dialog
    .getByRole('button', { name: 'Import unpublished draft', exact: true })
    .click();
  await dialog
    .getByRole('button', { name: 'Open imported workflow', exact: true })
    .click();
  await expect(page).toHaveURL(/\/workflows\/[^/]+$/u);
  const id = new URL(page.url()).pathname.split('/')[4];
  if (id === undefined) throw new Error('Imported workflow identifier missing');
  return id;
}

test('owned complete examples retain historical origin through independent edits and duplication, not portable reimport', async ({
  page,
  request,
}, info) => {
  test.setTimeout(120_000);
  const controlOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (
    controlOrigin === undefined ||
    process.env.EDITOR_BROWSER_CASE !== 'curated-templates'
  )
    throw new Error('Use the owned curated-template API fixture');
  const response = await request.get(`${controlOrigin}/curated-template-seed`);
  expect(response.ok()).toBe(true);
  const seed = (await response.json()) as Seed;
  await page.context().addCookies(seed.cookies);
  const importedWorkflowIds: string[] = [];
  for (const descriptor of CURATED_WORKFLOW_TEMPLATES) {
    await page.goto(`/w/${seed.workspaceId}/workflows`);
    await page
      .getByRole('button', { name: 'New workflow', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Choose a complete example…', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Import workflow',
      exact: true,
    });
    const choice = dialog.getByRole('button', {
      name: `Set up ${descriptor.title}`,
      exact: true,
    });
    await expect(choice).toBeEnabled();
    await expect(
      dialog.getByText(descriptor.inputSummary, { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText(descriptor.boundsSummary, { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText(descriptor.effectsSummary, { exact: true }),
    ).toBeVisible();
    await choice.click();
    await expect(dialog.getByLabel('Complete imported graph')).toBeVisible();
    await dialog
      .getByLabel('New workflow name')
      .fill(`F06 ${descriptor.templateId}`);
    if (descriptor.setupTargets.length > 0) {
      await expect(dialog.getByLabel('HTTPS endpoint')).toHaveValue('');
      await expect(dialog.getByLabel('Slack channel ID')).toHaveValue('');
      await expect(
        dialog.getByRole('button', { name: 'Preview import', exact: true }),
      ).toBeDisabled();
      await dialog.getByLabel('HTTPS endpoint').fill(seed.httpEndpoint);
      await dialog.getByLabel('Slack channel ID').fill(seed.slackChannel);
      for (const [index, name] of [
        'F06 controlled HTTP account',
        'F06 controlled Slack account',
      ].entries()) {
        const selector = dialog.getByRole('combobox').nth(index);
        await expect(selector).toContainText('Choose a connection');
        await expect(selector).toBeEnabled();
        await selector.click();
        await page.getByRole('option', { name, exact: true }).click();
      }
    }
    await dialog
      .getByRole('button', { name: 'Preview import', exact: true })
      .click();
    await expect(
      dialog.getByText(/Compatible with this workspace/u),
    ).toBeVisible();
    await dialog
      .getByLabel('New workflow name')
      .fill(`Independent ${descriptor.templateId}`);
    await expect(
      dialog.getByRole('button', {
        name: 'Import unpublished draft',
        exact: true,
      }),
    ).toBeDisabled();
    const id = await importReviewedDraft(page, dialog);
    importedWorkflowIds.push(id);
    await expect(
      page.getByText(
        `Originally based on ${descriptor.templateId}, version ${String(descriptor.templateVersion)}`,
        { exact: false },
      ),
    ).toBeVisible();
    expect(await readOrigin(page, seed.workspaceId, id)).toMatchObject({
      templateId: descriptor.templateId,
      templateVersion: descriptor.templateVersion,
      baseManifestDigest: descriptor.baseManifestDigest,
      derivation: 'direct',
    });
  }
  const editedWorkflowId = importedWorkflowIds[0];
  if (editedWorkflowId === undefined)
    throw new Error('Reviewed first template was not imported');
  await page.goto(`/w/${seed.workspaceId}/workflows/${editedWorkflowId}`);
  const originalOrigin = await readOrigin(
    page,
    seed.workspaceId,
    editedWorkflowId,
  );
  await page.getByTestId('rf__node-validate-request').focus();
  await page.keyboard.press('Enter');
  await page
    .getByLabel('Label', { exact: true })
    .fill('Independent edited validation');
  await page.keyboard.press('Tab');
  await expect
    .poll(
      async () =>
        (
          await readDraft(page, seed.workspaceId, editedWorkflowId)
        ).graph.nodes.find((node) => node.id === 'validate-request')?.label,
    )
    .toBe('Independent edited validation');
  await page
    .getByRole('button', { name: 'Rename workflow', exact: true })
    .click();
  const rename = page.getByRole('dialog', {
    name: 'Rename workflow',
    exact: true,
  });
  await rename
    .getByLabel('Workflow name')
    .fill('Independent renamed validation');
  await rename.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rename).not.toBeVisible();
  expect(await readOrigin(page, seed.workspaceId, editedWorkflowId)).toEqual(
    originalOrigin,
  );
  await page.getByRole('button', { name: 'Duplicate…', exact: true }).click();
  const duplicate = page.getByRole('dialog', {
    name: 'Duplicate workflow',
    exact: true,
  });
  await duplicate.getByLabel('Copy name').fill('Inherited edited example copy');
  const duplicated = page.waitForResponse(
    (result) =>
      new URL(result.url()).pathname.endsWith('/duplicate') &&
      result.request().method() === 'POST',
  );
  await duplicate
    .getByRole('button', { name: 'Duplicate workflow', exact: true })
    .click();
  const duplicationResponse = await duplicated;
  expect(duplicationResponse.status()).toBe(201);
  const duplicateWorkflowId = workflowDuplicateResponseSchema.parse(
    await duplicationResponse.json(),
  ).workflowId;
  await expect(page).toHaveURL(
    `/w/${seed.workspaceId}/workflows/${duplicateWorkflowId}`,
  );
  expect(await readOrigin(page, seed.workspaceId, duplicateWorkflowId)).toEqual(
    { ...originalOrigin, derivation: 'inherited' },
  );
  expect(
    (await readDraft(page, seed.workspaceId, duplicateWorkflowId)).graph,
  ).toEqual((await readDraft(page, seed.workspaceId, editedWorkflowId)).graph);
  await page.screenshot({
    path: info.outputPath('curated-origin-live-desktop.png'),
  });
  await page.getByRole('button', { name: 'Export…', exact: true }).click();
  const exporter = page.getByRole('dialog', {
    name: 'Export workflow',
    exact: true,
  });
  await exporter.getByRole('checkbox').focus();
  await page.keyboard.press('Space');
  const download = page.waitForEvent('download');
  await exporter
    .getByRole('button', { name: 'Download workflow JSON', exact: true })
    .click();
  const file = await download;
  const path = info.outputPath('independent-example.pertexo.json');
  await file.saveAs(path);
  const buffer = await readFile(path);
  const manifest = workflowPortableManifestSchema.parse(
    parsePortableJson(buffer.toString('utf8')),
  );
  expect(Object.hasOwn(manifest, 'templateOrigin')).toBe(false);
  await page.goto(`/w/${seed.workspaceId}/workflows`);
  await page
    .getByRole('button', { name: 'Import workflow…', exact: true })
    .click();
  const reimport = page.getByRole('dialog', {
    name: 'Import workflow',
    exact: true,
  });
  await reimport.getByLabel('Workflow JSON file').setInputFiles({
    name: 'ordinary.json',
    mimeType: 'application/json',
    buffer,
  });
  await reimport
    .getByLabel('New workflow name')
    .fill('Ordinary portable reimport');
  const reimportedWorkflowId = await importReviewedDraft(page, reimport);
  await expect(
    page.getByText('No recorded template origin.', { exact: true }),
  ).toBeVisible();
  expect(
    await readOrigin(page, seed.workspaceId, reimportedWorkflowId),
  ).toBeNull();
  expect(
    (await readDraft(page, seed.workspaceId, reimportedWorkflowId)).graph,
  ).toEqual(
    (await readDraft(page, seed.workspaceId, duplicateWorkflowId)).graph,
  );
  const evidence = await request.post(
    `${controlOrigin}/evidence/curated-templates`,
    {
      data: {
        workspaceId: seed.workspaceId,
        importedWorkflowIds,
        editedWorkflowId,
        duplicateWorkflowId,
        reimportedWorkflowId,
      },
    },
  );
  expect(evidence.ok()).toBe(true);
});
