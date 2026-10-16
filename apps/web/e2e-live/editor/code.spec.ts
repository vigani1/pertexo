import { expect } from '@playwright/test';
import {
  workflowNodeRunDiagnosticsResponseSchema,
  workflowNodeRunOutputResponseSchema,
} from '@pertexo/contracts';
import { test } from '../support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from '../support/ordinary-editor-session';
import {
  addSingleStep,
  createEditorWorkflow,
  readEditorDraft,
  publishSingleStep,
  startSingleStep,
  waitForRun,
} from '../support/authoring/single-step';

test('browser-authored Code uses the actual worker runner and keeps diagnostics private', async ({
  page,
  request,
}) => {
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Use the owned API fixture');
  await registerEditorUser(page, request, mailOrigin, 'Code owner');
  const workspaceId = await createEditorWorkspace(page, 'Code qualification');
  await page.goto(`/w/${workspaceId}/settings/variables`);
  await page.getByRole('button', { name: 'Add variable', exact: true }).click();
  await page
    .getByRole('region', { name: 'New variable', exact: true })
    .getByLabel('Name', { exact: true })
    .fill('RATE');
  const rate = page.getByRole('region', { name: 'RATE', exact: true });
  await rate.getByLabel('Type', { exact: true }).selectOption('number');
  await rate.getByLabel('Value', { exact: true }).fill('4');
  await page
    .getByRole('button', { name: 'Save variables', exact: true })
    .click();
  await expect(
    page.getByText('Saved revision 1 for new runs', { exact: true }),
  ).toBeVisible();
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Code qualification',
  );
  const editorUrl = new URL(page.url()).pathname;
  const nodeId = await addSingleStep(
    page,
    workflowPath,
    /^Code /u,
    'Calculate',
  );
  const code =
    "console.info('private Code log');\nreturn {total:require('lodash').sum([input.amount,$vars.RATE]),year:require('dayjs')('2026-01-01').year(),process:typeof process};";
  await page.getByLabel('JavaScript', { exact: true }).fill(code);
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes[0]?.config.code,
    )
    .toBe(code);
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  const mapping = page
    .getByRole('region', { name: 'Inputs', exact: true })
    .locator('ol > li')
    .last();
  await mapping.getByLabel('Field', { exact: true }).fill('amount');
  await mapping.getByRole('button', { name: 'Run input', exact: true }).click();
  await mapping.getByLabel('Run input path', { exact: true }).fill('$.amount');
  await page.keyboard.press('Tab');
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  await page
    .getByLabel('Sample input (JSON)', { exact: true })
    .fill('{"amount":3}');
  await page.getByRole('button', { name: 'Check setup', exact: true }).click();
  await expect(
    page.getByText('Setup looks right', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Run (?:another )?test$/u }).click();
  await expect(page.getByRole('region', { name: 'Test result' })).toContainText(
    '2026',
  );
  await publishSingleStep(page, workflowPath);
  const runId = await startSingleStep(page, { amount: 3 });
  const run = await waitForRun(page, workspaceId, runId, 'succeeded');
  const node = run.nodes.find((node) => node.nodeId === nodeId);
  if (node === undefined) throw new Error('Code node run missing');
  const base = `/v1/workspaces/${workspaceId}/runs/${runId}/node-runs/${node.id}`;
  const output = await page.request.get(base + '/output');
  expect(output.status()).toBe(200);
  expect(
    workflowNodeRunOutputResponseSchema.parse(await output.json()).output,
  ).toEqual({
    kind: 'inline',
    value: { total: 7, year: 2026, process: 'undefined' },
  });
  const diagnostics = await page.request.get(base + '/diagnostics');
  expect(diagnostics.status()).toBe(200);
  expect(
    workflowNodeRunDiagnosticsResponseSchema.parse(await diagnostics.json())
      .diagnostics,
  ).toMatchObject({ logs: [{ level: 'info', message: 'private Code log' }] });
  await page.goto(editorUrl);
  await page.getByTestId(`rf__node-${nodeId}`).focus();
  await page.keyboard.press('Enter');
  await page
    .getByLabel('JavaScript', { exact: true })
    .fill(
      "console.warn('before failure');\nthrow new Error('private Code failure');",
    );
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes[0]?.config.code,
    )
    .toContain('private Code failure');
  await page.getByRole('button', { name: 'Publish v2', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Publish v2', exact: true })
    .getByRole('button', { name: 'Publish v2', exact: true })
    .click();
  await expect(page.getByText('v2 is live', { exact: true })).toBeVisible();
  const failedId = await startSingleStep(page, { amount: 3 });
  const failed = await waitForRun(page, workspaceId, failedId, 'failed');
  const failedNode = failed.nodes.find((node) => node.nodeId === nodeId);
  if (failedNode === undefined) throw new Error('Failed Code node missing');
  const detail = await page.request.get(
    `/v1/workspaces/${workspaceId}/runs/${failedId}/node-runs/${failedNode.id}/diagnostics`,
  );
  expect(
    workflowNodeRunDiagnosticsResponseSchema.parse(await detail.json())
      .diagnostics?.error,
  ).toMatchObject({ message: 'private Code failure', line: 2 });
  expect(JSON.stringify(failed)).not.toContain('private Code failure');
});
