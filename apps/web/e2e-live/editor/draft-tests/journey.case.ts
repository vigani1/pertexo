import { expect, type Page } from '@playwright/test';
import {
  workflowTestAcceptedSchema,
  workflowTestDetailSchema,
  workflowRunListResponseSchema,
  workflowNodeRunOutputResponseSchema,
  workflowVersionsResponseSchema,
} from '@pertexo/contracts';
import { test } from '../../support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from '../../support/ordinary-editor-session';
import {
  addSingleStep,
  createEditorWorkflow,
  readEditorDraft,
  publishSingleStep,
  startSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';

async function appendStep({
  page,
  path,
  afterNodeId,
  kind,
  label,
}: Readonly<{
  page: Page;
  path: string;
  afterNodeId: string;
  kind: RegExp;
  label: string;
}>) {
  const before = await readEditorDraft(page, path);
  await page.getByTestId(`rf__node-${afterNodeId}`).focus();
  await page.keyboard.press('Enter');
  await page
    .getByRole('complementary', { name: 'Add a step' })
    .getByRole('button', { name: kind })
    .click();
  await expect
    .poll(async () => (await readEditorDraft(page, path)).graph.nodes.length)
    .toBe(before.graph.nodes.length + 1);
  const step = (await readEditorDraft(page, path)).graph.nodes.find(
    (node) => !before.graph.nodes.some((old) => old.id === node.id),
  );
  if (step === undefined) throw new Error('New draft step was not saved');
  await page.getByTestId(`rf__node-${step.id}`).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Label', { exact: true }).fill(label);
  await page.keyboard.press('Tab');
  expect(
    (await readEditorDraft(page, path)).graph.edges.filter(
      (edge) => edge.target.nodeId === step.id,
    ),
  ).toEqual([
    expect.objectContaining({
      source: { nodeId: afterNodeId, port: 'out' },
      target: { nodeId: step.id, port: 'in' },
    }),
  ]);
  return step.id;
}
async function startTest(
  page: Page,
  path: string,
  input: unknown,
  finalStepId: string,
) {
  const preparedResponse = page.waitForResponse((response) =>
    response.url().endsWith(`${path}/draft/tests/prepare`),
  );
  await page
    .getByRole('button', { name: 'Test workflow', exact: true })
    .click();
  const prepared = await preparedResponse;
  expect(prepared.status(), JSON.stringify(await prepared.json())).toBe(200);
  const dialog = page.getByRole('dialog', {
    name: 'Test workflow',
    exact: true,
  });
  await dialog
    .getByLabel('Test input (JSON)', { exact: true })
    .fill(JSON.stringify(input));
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith(`${path}/draft/tests`) &&
      response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Start test', exact: true }).click();
  const accepted = await response;
  expect(accepted.status()).toBe(202);
  const runId = workflowTestAcceptedSchema.parse(await accepted.json()).runId;
  const snapshotResponse = await page.request.get(
    `${path}/draft/tests/${runId}`,
  );
  expect(snapshotResponse.status()).toBe(200);
  const snapshot = workflowTestDetailSchema.parse(
    await snapshotResponse.json(),
  );
  expect(snapshot.graph.nodes.at(-1)?.id).toBe(finalStepId);
  return runId;
}

test('saved draft tests run on the worker, skip waits and pinned human steps, and keep published execution separate', async ({
  page,
  request,
}) => {
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Use the owned API fixture');
  await registerEditorUser(page, request, mailOrigin, 'Draft test owner');
  const workspaceId = await createEditorWorkspace(
    page,
    'Draft test qualification',
  );
  const path = await createEditorWorkflow(
    page,
    workspaceId,
    'Draft test qualification',
  );
  const editorUrl = new URL(page.url()).pathname;
  const codeId = await addSingleStep(page, path, /^Code /u, 'Calculate test');
  const source =
    "console.info('real draft-test Code execution'); return {amount:input.amount*2};";
  await page
    .getByRole('textbox', { name: 'JavaScript', exact: true })
    .fill(source);
  await page.keyboard.press('Tab');
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  const row = page
    .getByRole('region', { name: 'Inputs', exact: true })
    .locator('ol > li')
    .last();
  await row.getByLabel('Field', { exact: true }).fill('amount');
  await row.getByRole('button', { name: 'Run input', exact: true }).click();
  await row.getByLabel('Run input path', { exact: true }).fill('$.amount');
  await page.keyboard.press('Tab');
  const waitId = await appendStep({
    page,
    path,
    afterNodeId: codeId,
    kind: /^Wait /u,
    label: 'Immediate test wait',
  });
  const approvalId = await appendStep({
    page,
    path,
    afterNodeId: waitId,
    kind: /^Approval /u,
    label: 'Review test',
  });
  const first = await startTest(page, path, { amount: 21 }, approvalId);
  const stopped = await waitForRun(page, workspaceId, first, 'failed');
  expect(stopped.run.triggerType).toBe('test');
  expect(
    stopped.nodes.find((node) => node.nodeId === waitId)?.status,
    JSON.stringify(stopped),
  ).toBe('succeeded');
  expect(
    stopped.nodes.find((node) => node.nodeId === approvalId)?.safeErrorCode,
  ).toBe('test.pin_required');
  const history = page.getByRole('region', {
    name: 'Workflow tests',
    exact: true,
  });
  await history
    .getByRole('button', { name: 'Test history', exact: true })
    .click();
  await expect(
    history.getByText('Pin this step to continue the test.', { exact: true }),
  ).toBeVisible();
  await expect(
    history.getByText('Wait skipped in test', { exact: true }),
  ).toBeVisible();
  const versions = workflowVersionsResponseSchema.parse(
    await (await page.request.get(`${path}/versions`)).json(),
  );
  expect(versions.items).toEqual([]);
  await page.getByTestId(`rf__node-${approvalId}`).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  await page.getByRole('button', { name: 'Paste JSON…', exact: true }).click();
  await page
    .getByLabel('Output (JSON)', { exact: true })
    .fill('{"selectedPort":"approved","comment":"Synthetic decision"}');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Pin output', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const second = await startTest(page, path, { amount: 21 }, approvalId);
  const succeeded = await waitForRun(page, workspaceId, second, 'succeeded');
  const code = succeeded.nodes.find((node) => node.nodeId === codeId);
  if (code === undefined) throw new Error('Test Code result missing');
  expect(
    workflowNodeRunOutputResponseSchema.parse(
      await (
        await page.request.get(
          `/v1/workspaces/${workspaceId}/runs/${second}/node-runs/${code.id}/output`,
        )
      ).json(),
    ).output,
  ).toEqual({ kind: 'inline', value: { amount: 42 } });
  await page.getByTestId(`rf__node-${codeId}`).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  const inspectorResult = page.getByRole('region', {
    name: 'Latest workflow test',
    exact: true,
  });
  await expect(inspectorResult).toContainText('42');
  await inspectorResult
    .getByRole('button', { name: 'View full test history', exact: true })
    .click();
  await expect(history).toBeFocused();
  const [canvas, dock] = await Promise.all([
    page.locator('.react-flow').boundingBox(),
    history.boundingBox(),
  ]);
  if (canvas === null || dock === null)
    throw new Error('Canvas or test dock missing');
  expect(canvas.y + canvas.height).toBeLessThanOrEqual(dock.y + 1);
  const codeResult = history.getByRole('region', {
    name: 'Test result: Calculate test',
    exact: true,
  });
  await codeResult
    .getByRole('button', { name: 'Pin output…', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Pin output', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const third = await startTest(page, path, { amount: 99 }, approvalId);
  await waitForRun(page, workspaceId, third, 'succeeded');
  await expect(
    history.getByText('Pinned · step not called', { exact: true }),
  ).toHaveCount(2);
  const realHistory = workflowRunListResponseSchema.parse(
    await (await page.request.get(`/v1/workspaces/${workspaceId}/runs`)).json(),
  );
  expect(realHistory.items).toEqual([]);
  await page.screenshot({ path: '/tmp/pertexo-draft-tests-desktop.png' });
  await page.setViewportSize({ width: 375, height: 768 });
  // On phones the test actions join the editor's ⋯ menu.
  await page
    .getByRole('button', { name: 'More workflow actions', exact: true })
    .click();
  await expect(
    page.getByRole('menuitem', { name: 'Test workflow', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Publish v1', exact: true }),
  ).toBeInViewport();
  await expect(
    page.getByRole('button', { name: 'Run (publish first)', exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: '/tmp/pertexo-draft-tests-phone.png' });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  // After a reload the bar waits until asked; the last test is in history.
  await expect(history).toHaveCount(0);
  await page
    .getByRole('button', { name: 'More test actions', exact: true })
    .click();
  await page
    .getByRole('menuitem', { name: 'Test history', exact: true })
    .click();
  await expect(
    history.getByText('Test · Succeeded', { exact: true }),
  ).toBeVisible();
  await publishSingleStep(page, path);
  const published = await startSingleStep(page, { amount: 7 });
  const real = await waitForRun(page, workspaceId, published, 'waiting');
  const realCode = real.nodes.find((node) => node.nodeId === codeId);
  if (realCode === undefined) throw new Error('Published Code step missing');
  expect(
    workflowNodeRunOutputResponseSchema.parse(
      await (
        await page.request.get(
          `/v1/workspaces/${workspaceId}/runs/${published}/node-runs/${realCode.id}/output`,
        )
      ).json(),
    ).output,
  ).toEqual({ kind: 'inline', value: { amount: 14 } });
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Cancel run', exact: true })
    .click();
  await waitForRun(page, workspaceId, published, 'canceled');
  await page.goto(editorUrl);
});
