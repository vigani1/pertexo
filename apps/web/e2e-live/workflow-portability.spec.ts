import { readFile } from 'node:fs/promises';
import { expect, type Page, type TestInfo } from '@playwright/test';
import {
  workflowDraftResponseSchema,
  workflowPublishResponseSchema,
} from '@pertexo/contracts';
import {
  parsePortableJson,
  workflowPortableManifestSchema,
  type WorkflowPortableManifest,
} from '@pertexo/workflow-model';
import { test } from './support/browser-fixture';
import { startSingleStep, waitForRun } from './support/authoring/single-step';

interface Seed {
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  sourceWorkflowId: string;
  coreWorkflowId: string;
  versionId: string;
  destinationConnectionId: string;
  cookies: { name: string; value: string; url: string }[];
}

async function downloadReviewedSource(
  page: Page,
  info: TestInfo,
  name: string,
) {
  const dialog = page.getByRole('dialog', {
    name: 'Export workflow',
    exact: true,
  });
  await expect(dialog.getByLabel('Complete saved source graph')).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Download workflow JSON' }),
  ).toBeDisabled();
  await dialog.getByRole('checkbox').focus();
  await page.keyboard.press('Space');
  await expect(dialog.getByRole('checkbox')).toBeChecked();
  const exported = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith('/export') &&
      response.request().method() === 'POST',
    { timeout: 10_000 },
  );
  const downloaded = page.waitForEvent('download', { timeout: 10_000 }).then(
    (file) => ({ file }),
    () => ({ file: undefined }),
  );
  await dialog.getByRole('button', { name: 'Download workflow JSON' }).click();
  const response = await exported;
  let safeCode = 'unrecognized_problem';
  if (!response.ok()) {
    const problem: unknown = await response.json().catch(() => undefined);
    if (
      typeof problem === 'object' &&
      problem !== null &&
      'code' in problem &&
      typeof problem.code === 'string' &&
      /^[a-z0-9_.-]{1,128}$/u.test(problem.code)
    )
      safeCode = problem.code;
  }
  expect(
    response.status(),
    `Export response ${String(response.status())}: ${safeCode}`,
  ).toBe(200);
  expect(response.headers()['cache-control']).toContain('no-store');
  const { file } = await downloaded;
  if (file === undefined)
    throw new Error(
      'Export returned successfully but the browser did not download a file',
    );
  expect(file.suggestedFilename()).toBe('pertexo-workflow.json');
  const path = info.outputPath(name);
  await file.saveAs(path);
  const buffer = await readFile(path);
  const manifest = workflowPortableManifestSchema.parse(
    parsePortableJson(buffer.toString('utf8')),
  );
  return { buffer, manifest };
}

async function openImport(
  page: Page,
  workspaceId: string,
  file: Buffer,
  name: string,
) {
  await page.goto(`/w/${workspaceId}/workflows`);
  await page.getByRole('button', { name: 'Import workflow…' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', {
    name: 'Import workflow',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Workflow JSON file')).toHaveCount(1);
  await dialog.getByLabel('Workflow JSON file').setInputFiles({
    name: 'portable.json',
    mimeType: 'application/json',
    buffer: file,
  });
  await expect(dialog.getByLabel('Complete imported graph')).toBeVisible();
  await dialog.getByLabel('New workflow name').fill(name);
  return dialog;
}

async function confirmImport(
  page: Page,
  dialog: Awaited<ReturnType<typeof openImport>>,
) {
  await dialog.getByRole('button', { name: 'Preview import' }).click();
  await expect(
    dialog.getByText(/Compatible with this workspace/u),
  ).toBeVisible();
  await dialog
    .getByRole('button', { name: 'Import unpublished draft' })
    .click();
  await dialog.getByRole('button', { name: 'Open imported workflow' }).click();
  await expect(page).toHaveURL(/\/workflows\/[^/]+$/u);
  const id = new URL(page.url()).pathname.split('/')[4];
  if (id === undefined) throw new Error('Imported workflow identifier missing');
  return id;
}

async function readDraft(page: Page, workspaceId: string, workflowId: string) {
  const response = await page.request.get(
    `/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
  );
  expect(response.ok()).toBe(true);
  return workflowDraftResponseSchema.parse(await response.json());
}

function verifyPortableSource(
  manifest: WorkflowPortableManifest,
  graph: Awaited<ReturnType<typeof readDraft>>['graph'],
) {
  expect(manifest.graph.nodes.map((node) => node.id)).toEqual(
    graph.nodes.map((node) => node.id),
  );
  expect(
    manifest.graph.nodes.every(
      (node) => Object.keys(node.connectionRefs).length === 0,
    ),
  ).toBe(true);
}

test('real cross-workspace reviewed exports, explicit rebinding, independent editing and core execution', async ({
  page,
  request,
}, info) => {
  const origin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (origin === undefined)
    throw new Error('Use the owned API portability fixture');
  const seeded = await request.get(`${origin}/workflow-portability-seed`);
  expect(seeded.ok()).toBe(true);
  const seed = (await seeded.json()) as Seed;
  await page.context().addCookies(seed.cookies);
  await page.goto(
    `/w/${seed.sourceWorkspaceId}/workflows/${seed.sourceWorkflowId}`,
  );
  const source = await readDraft(
    page,
    seed.sourceWorkspaceId,
    seed.sourceWorkflowId,
  );
  await page.getByRole('button', { name: 'Export…', exact: true }).click();
  const savedFile = await downloadReviewedSource(
    page,
    info,
    'saved-draft.pertexo.json',
  );
  verifyPortableSource(savedFile.manifest, source.graph);
  expect(savedFile.manifest.connectionSlots).toHaveLength(1);
  await page.goto(
    `/w/${seed.sourceWorkspaceId}/workflows/${seed.sourceWorkflowId}/versions`,
  );
  await page.getByRole('button', { name: 'Export v1', exact: true }).click();
  const versionFile = await downloadReviewedSource(
    page,
    info,
    'selected-version.pertexo.json',
  );
  expect(versionFile.manifest).toEqual(savedFile.manifest);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const slotDialog = await openImport(
    page,
    seed.destinationWorkspaceId,
    versionFile.buffer,
    'Explicitly rebound import',
  );
  await expect(
    slotDialog.getByRole('button', { name: 'Preview import' }),
  ).toBeDisabled();
  const selector = slotDialog.getByRole('combobox');
  await expect(selector).toContainText('Choose a connection');
  await expect(selector).toBeEnabled({ timeout: 10_000 });
  await selector.focus();
  await expect(selector).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(selector).toHaveAttribute('aria-expanded', 'true');
  const destinationOption = page.getByRole('option', {
    name: 'Explicit destination HTTP account',
    exact: true,
  });
  await expect(destinationOption).toBeVisible({ timeout: 10_000 });
  await destinationOption.click();
  await expect(selector).toContainText('Explicit destination HTTP account');
  await slotDialog.getByRole('button', { name: 'Preview import' }).click();
  await expect(
    slotDialog.getByText(/Compatible with this workspace/u),
  ).toBeVisible();
  await slotDialog
    .getByLabel('New workflow name')
    .fill('Independent rebound draft');
  await expect(
    slotDialog.getByRole('button', { name: 'Import unpublished draft' }),
  ).toBeDisabled();
  const bounds = await slotDialog.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: info.outputPath('portability-live-mobile.png'),
  });
  const slotImportedWorkflowId = await confirmImport(page, slotDialog);
  await page.setViewportSize({ width: 1280, height: 900 });
  const slotDraft = await readDraft(
    page,
    seed.destinationWorkspaceId,
    slotImportedWorkflowId,
  );
  expect(
    slotDraft.graph.nodes.find((node) => node.definition.key === 'http.request')
      ?.connectionRefs,
  ).toEqual({ http_headers: seed.destinationConnectionId });
  const coreNode = slotDraft.graph.nodes.find(
    (node) => node.definition.key === 'core.set',
  );
  if (coreNode === undefined) throw new Error('Imported core step missing');
  await page.getByTestId(`rf__node-${coreNode.id}`).focus();
  await page.keyboard.press('Enter');
  await page
    .getByLabel('Label', { exact: true })
    .fill('Edited only in destination');
  await page.keyboard.press('Tab');
  await expect
    .poll(
      async () =>
        (
          await readDraft(
            page,
            seed.destinationWorkspaceId,
            slotImportedWorkflowId,
          )
        ).graph.nodes.find((node) => node.id === coreNode.id)?.label,
    )
    .toBe('Edited only in destination');
  expect(
    (await readDraft(page, seed.sourceWorkspaceId, seed.sourceWorkflowId))
      .graph,
  ).toEqual(source.graph);
  await page.screenshot({
    path: info.outputPath('portability-live-desktop.png'),
  });

  await page.goto(
    `/w/${seed.sourceWorkspaceId}/workflows/${seed.coreWorkflowId}`,
  );
  await page.getByRole('button', { name: 'Export…', exact: true }).click();
  const coreFile = await downloadReviewedSource(
    page,
    info,
    'core-only.pertexo.json',
  );
  expect(coreFile.manifest.connectionSlots).toEqual([]);
  const coreDialog = await openImport(
    page,
    seed.destinationWorkspaceId,
    coreFile.buffer,
    'Runnable independent core import',
  );
  const coreImportedWorkflowId = await confirmImport(page, coreDialog);
  const publication = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/v1/workspaces/${seed.destinationWorkspaceId}/workflows/${coreImportedWorkflowId}/publish` &&
      response.request().method() === 'POST' &&
      response.ok(),
  );
  await page.getByRole('button', { name: 'Publish v1', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Publish v1', exact: true })
    .getByRole('button', { name: 'Publish v1', exact: true })
    .click();
  const version = workflowPublishResponseSchema.parse(
    await (await publication).json(),
  ).version;
  await expect(page.getByText('v1 is live', { exact: true })).toBeVisible();
  const coreImportedRunId = await startSingleStep(page, {
    value: 'portable-core-proof',
  });
  const run = await waitForRun(
    page,
    seed.destinationWorkspaceId,
    coreImportedRunId,
    'succeeded',
  );
  expect(run.run.workflowVersionId).toBe(version.id);
  const evidence = await request.post(`${origin}/evidence/portability`, {
    data: {
      sourceWorkspaceId: seed.sourceWorkspaceId,
      destinationWorkspaceId: seed.destinationWorkspaceId,
      sourceWorkflowId: seed.sourceWorkflowId,
      coreWorkflowId: seed.coreWorkflowId,
      slotImportedWorkflowId,
      coreImportedWorkflowId,
      coreImportedVersionId: version.id,
      coreImportedRunId,
    },
  });
  expect(evidence.ok()).toBe(true);

  const lost = await openImport(
    page,
    seed.destinationWorkspaceId,
    coreFile.buffer,
    'Clear this private intent',
  );
  await lost.getByRole('button', { name: 'Preview import' }).click();
  await expect(lost.getByText(/Compatible with this workspace/u)).toBeVisible();
  const denied = await request.post(`${origin}/workflow-portability-deny`);
  expect(denied.ok()).toBe(true);
  await lost.getByRole('button', { name: 'Preview import' }).click();
  await expect(lost.getByText(/Access changed/u)).toBeVisible();
  await expect(lost.getByLabel('Workflow JSON file')).toHaveCount(0);
  await expect(lost.getByLabel('New workflow name')).toHaveCount(0);
  await expect(lost.getByLabel('Complete imported graph')).toHaveCount(0);
  await expect(
    lost.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeEnabled();
  await lost.getByRole('button', { name: 'Cancel', exact: true }).click();
});
