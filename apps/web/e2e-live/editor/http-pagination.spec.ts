import { mkdir } from 'node:fs/promises';
import { expect } from '@playwright/test';
import {
  nodeTestExecuteAcceptedResponseSchema,
  nodeTestRequestSchema,
  previewRunResponseSchema,
  workflowNodeRunOutputResponseSchema,
} from '@pertexo/contracts';
import { test } from '../support/browser-fixture';
import { createOwnedHttpConnection } from '../support/authoring/http-connection';
import {
  addSingleStep,
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
  startSingleStep,
  waitForRun,
} from '../support/authoring/single-step';

const expected = {
  items: [{ id: 1 }, { id: 2 }, { id: 3 }],
  pageCount: 3,
  complete: true,
  status: 200,
};
const images = '/tmp/pertexo-f32-pagination-screenshots';

test('fetches three authenticated pages in a real run and single-step preview', async ({
  page,
  request,
}) => {
  await mkdir(images, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 768 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { workspaceId } = await createOwnedHttpConnection(page, request);
  const path = await createEditorWorkflow(
    page,
    workspaceId,
    'Fetch every page',
  );
  const nodeId = await addSingleStep(
    page,
    path,
    /HTTP request/u,
    'Fetch orders',
  );
  await page
    .getByLabel('URL', { exact: true })
    .fill('https://pertexo-controlled-action.example.test/pages?page=1');
  await page.getByLabel('Timeout (in seconds)', { exact: true }).fill('1');
  await page.getByLabel('HTTP connection', { exact: true }).click();
  await page
    .getByRole('option', { name: 'Owned HTTP credential', exact: true })
    .click();
  const summary = page.locator('summary').filter({ hasText: 'Pagination' });
  await summary.click();
  await page.getByLabel('Pagination mode', { exact: true }).click();
  await page
    .getByRole('option', { name: 'Next page link', exact: true })
    .click();
  await page.getByLabel('Max pages', { exact: true }).fill('3');
  await page.getByLabel('Items path', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${images}/desktop.png` });
  await page.setViewportSize({ width: 375, height: 768 });
  await page
    .getByRole('navigation', { name: 'Editor panels' })
    .getByRole('button', { name: 'Step', exact: true })
    .click();
  await page.getByLabel('Items path', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${images}/phone.png` });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 768 });
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, path)).graph.nodes[0]?.config.pagination,
    )
    .toMatchObject({ mode: 'next_link', maxPages: 3, itemsPath: '$.data' });
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  await page.getByLabel('Sample input (JSON)', { exact: true }).fill('{}');
  await page.getByRole('button', { name: 'Check setup', exact: true }).click();
  await expect(
    page.getByText('Setup looks right', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('switch', {
      name: 'I understand this test runs for real',
      exact: true,
    })
    .check();
  const pending = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `${path}/draft/nodes/${nodeId}/test` &&
      nodeTestRequestSchema.safeParse(response.request().postDataJSON()).data
        ?.mode === 'test_execute',
  );
  await page.getByRole('button', { name: /^Run (?:another )?test$/u }).click();
  const accepted = nodeTestExecuteAcceptedResponseSchema.parse(
    await (await pending).json(),
  );
  const readPreview = async () => {
    const response = await page.request.get(
      `/v1/workspaces/${workspaceId}/previews/${accepted.preview.id}`,
    );
    expect(response.ok()).toBe(true);
    return previewRunResponseSchema.parse(await response.json()).preview;
  };
  await expect.poll(async () => (await readPreview()).status).toBe('succeeded');
  expect((await readPreview()).output).toMatchObject({
    kind: 'inline',
    value: expected,
  });
  await publishSingleStep(page, path);
  const runId = await startSingleStep(page, {});
  const run = await waitForRun(page, workspaceId, runId, 'succeeded');
  const node = run.nodes.find((node) => node.nodeId === nodeId);
  if (node === undefined) throw new Error('HTTP step did not execute');
  const output = await page.request.get(
    `/v1/workspaces/${workspaceId}/runs/${runId}/node-runs/${node.id}/output`,
  );
  expect(output.ok()).toBe(true);
  expect(
    workflowNodeRunOutputResponseSchema.parse(await output.json()).output,
  ).toMatchObject({ kind: 'inline', value: expected });
});
