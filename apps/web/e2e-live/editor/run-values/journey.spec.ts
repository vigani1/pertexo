import { expect } from '@playwright/test';
import { workflowRunListResponseSchema } from '@pertexo/contracts';
import { test } from '../../support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
} from '../../support/ordinary-editor-session';
import {
  createEditorWorkflow,
  addSingleStep,
  publishSingleStep,
  startSingleStep,
  waitForRun,
  readEditorDraft,
} from '../../support/authoring/single-step';
test('authors business values, runs them on the worker and finds the real run by its exact pair', async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  const origin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (origin === undefined) throw new Error('Owned mail fixture missing');
  await registerEditorUser(page, request, origin, 'Run values owner');
  const workspaceId = await createEditorWorkspace(
    page,
    'Run values qualification',
  );
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Find an order',
  );
  await addSingleStep(page, workflowPath, /^Save run values/u, 'Order lookup');
  await page.getByRole('tab', { name: 'Setup', exact: true }).click();
  await page
    .getByRole('button', { name: 'Add run value', exact: true })
    .click();
  await page.getByLabel('Key', { exact: true }).fill('orderId');
  await page.getByLabel('Value', { exact: true }).fill('A-1042');
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes[0]
          ?.inputMappings,
    )
    .toEqual({ values: { kind: 'literal', value: { orderId: 'A-1042' } } });
  await publishSingleStep(page, workflowPath);
  const runId = await startSingleStep(page, {});
  const result = await waitForRun(page, workspaceId, runId, 'succeeded');
  expect(result.run.runValues).toEqual({ orderId: 'A-1042' });
  await expect(
    page.getByText('Saved run values', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('A-1042', { exact: true })).toBeVisible();
  await page.goto(`/w/${workspaceId}/runs`);
  await page.getByText('Run value', { exact: true }).click();
  await page.getByLabel('Run value key', { exact: true }).fill('orderId');
  await page.getByLabel('Exact value', { exact: true }).fill('A-1042');
  const response = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith('/runs') &&
      url.searchParams.get('runValueKey') === 'orderId' &&
      url.searchParams.get('runValue') === 'A-1042'
    );
  });
  await page.getByRole('button', { name: 'Apply value filter' }).click();
  const matched = await response;
  expect(matched.status()).toBe(200);
  expect(
    workflowRunListResponseSchema
      .parse(await matched.json())
      .items.map((run) => run.id),
  ).toContain(runId);
  await expect(page.getByText('Find an order', { exact: true })).toBeVisible();
  await page.getByLabel('Exact value', { exact: true }).fill('a-1042');
  const noMatch = page.waitForResponse(
    (response) =>
      new URL(response.url()).searchParams.get('runValue') === 'a-1042',
  );
  await page.getByRole('button', { name: 'Apply value filter' }).click();
  expect(
    workflowRunListResponseSchema.parse(await (await noMatch).json()).items,
  ).toEqual([]);
});
