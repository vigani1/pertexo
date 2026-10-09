import { expect, type Page } from '@playwright/test';
import {
  workflowDraftResponseSchema,
  workflowVersionsResponseSchema,
  workflowRunResponseSchema,
} from '@pertexo/contracts';

/** The existing New workflow form; never seeds a graph or a version. */
export async function createEditorWorkflow(
  page: Page,
  workspaceId: string,
  name: string,
) {
  await page.goto(`/w/${workspaceId}/workflows`);
  await page.getByRole('button', { name: 'New workflow', exact: true }).click();
  await page.getByLabel('Workflow name', { exact: true }).fill(name);
  await page
    .getByRole('button', { name: 'Create workflow', exact: true })
    .click();
  await expect(page).toHaveURL(/\/workflows\/[^/]+$/u);
  const workflowId = new URL(page.url()).pathname.split('/')[4];
  if (workflowId === undefined)
    throw new Error('Created workflow URL is missing its ID');
  return `/v1/workspaces/${workspaceId}/workflows/${workflowId}`;
}

export async function readEditorDraft(page: Page, workflowPath: string) {
  const response = await page.request.get(`${workflowPath}/draft`);
  expect(response.status()).toBe(200);
  return workflowDraftResponseSchema.parse(await response.json());
}

/** Selects a browser-created step through its keyboard-accessible canvas node. */
export async function addSingleStep(
  page: Page,
  workflowPath: string,
  kind: RegExp,
  label: string,
) {
  await page
    .getByRole('complementary', { name: 'Add a step' })
    .getByRole('button', { name: kind })
    .click();
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes.length,
    )
    .toBe(1);
  const node = (await readEditorDraft(page, workflowPath)).graph.nodes[0];
  if (node === undefined) throw new Error('Browser-authored step is missing');
  await page.getByTestId(`rf__node-${node.id}`).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Label', { exact: true }).fill(label);
  await page.keyboard.press('Tab');
  return node.id;
}

export async function publishSingleStep(page: Page, workflowPath: string) {
  await page.getByRole('button', { name: 'Publish v1', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Publish v1', exact: true })
    .getByRole('button', { name: 'Publish v1', exact: true })
    .click();
  await expect(page.getByText('v1 is live', { exact: true })).toBeVisible();
  const response = await page.request.get(`${workflowPath}/versions`);
  expect(response.status()).toBe(200);
  const versions = workflowVersionsResponseSchema.parse(await response.json());
  expect(versions.items).toHaveLength(1);
  const version = versions.items[0];
  if (version === undefined) throw new Error('Published version is missing');
  return version;
}

export async function startSingleStep(page: Page, input: unknown) {
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Run with input…', exact: true })
    .click();
  await page
    .getByLabel('Run input (JSON)', { exact: true })
    .fill(JSON.stringify(input));
  await page
    .getByRole('button', { name: 'Start published version', exact: true })
    .click();
  await expect(page).toHaveURL(/\/runs\/[^/]+$/u);
  const runId = new URL(page.url()).pathname.split('/')[4];
  if (runId === undefined)
    throw new Error('Accepted run URL is missing its ID');
  return runId;
}

export async function waitForRun(
  page: Page,
  workspaceId: string,
  runId: string,
  status: 'succeeded' | 'failed' | 'waiting' | 'canceled',
) {
  const path = `/v1/workspaces/${workspaceId}/runs/${runId}`;
  async function read() {
    const response = await page.request.get(path);
    expect(response.status()).toBe(200);
    return workflowRunResponseSchema.parse(await response.json());
  }
  await expect
    .poll(async () => (await read()).run.status, { timeout: 15_000 })
    .toBe(status);
  return read();
}
