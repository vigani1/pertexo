import { expect, type Page } from '@playwright/test';
import {
  nodeTestExecuteAcceptedResponseSchema,
  workflowRunStartResponseSchema,
} from '@pertexo/contracts';
import { mapBrowserInput } from '../../../test/support/browser/inputs';
import { test } from './account';
import { model, openModelProvider } from './model-provider';
import { connectModel, modelScreenshots } from './model-editor';
import { openNewEditorWorkspace } from '../../support/ordinary-editor-session';
import {
  addSingleStep,
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
  startSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';

test.use({ actionTimeout: 10_000, viewport: { width: 1280, height: 1080 } });

test('authors stable categories and routes a published run and replay', async ({
  page,
}, info) => {
  const provider = await openModelProvider();
  try {
    const workspace = await openNewEditorWorkspace(
      page,
      'Classification workspace',
    );
    await connectModel(page, workspace);
    const path = await createEditorWorkflow(page, workspace, 'Route support');
    const editor = new URL(page.url()).pathname;
    const source = await addSingleStep(
      page,
      path,
      /^Classify\b/u,
      'Classify request',
    );
    await page.getByRole('tab', { name: 'Setup', exact: true }).click();
    await page.getByLabel('Model identifier', { exact: true }).fill(model);
    await page.getByLabel('AI model connection', { exact: true }).click();
    await page
      .getByRole('option', { name: 'Order model', exact: true })
      .click();
    const addCategory = page.getByRole('button', {
      name: 'Add category',
      exact: true,
    });
    const names = page.getByLabel('Category name', { exact: true });
    const descriptions = page.getByLabel('Description', { exact: true });
    await addCategory.click();
    await names.nth(0).fill('Billing');
    await descriptions.nth(0).fill('Invoices and payment questions');
    await addCategory.click();
    await names.nth(1).fill('Access');
    await descriptions.nth(1).fill('Sign-in and permissions');
    await descriptions.nth(1).blur();

    await mapBrowserInput({
      page,
      field: 'text',
      source: 'Run input',
      path: '$.message',
    });
    for (const category of ['Billing', 'Access', 'Other']) {
      await selectSource(page, source);
      await page
        .getByRole('button', { name: 'Step actions', exact: true })
        .click();
      await page
        .getByRole('menuitem', { name: 'Add step after', exact: true })
        .click();
      const dialog = page.getByRole('dialog', {
        name: 'Add a step after “Classify request”',
      });
      await dialog.getByLabel('Link from', { exact: true }).click();
      await page.getByRole('option', { name: category, exact: true }).click();
      await dialog.getByRole('button', { name: /Set fields/u }).click();
      await page.getByLabel('Label', { exact: true }).fill(`Route ${category}`);
      await page.keyboard.press('Tab');
    }
    await expect
      .poll(async () => (await readEditorDraft(page, path)).graph.edges.length)
      .toBe(3);
    const before = (await readEditorDraft(page, path)).graph.edges;
    await selectSource(page, source);
    await page.getByRole('tab', { name: 'Setup', exact: true }).click();
    await names.nth(0).fill('Payments');
    await names.nth(0).blur();
    await page
      .getByRole('button', { name: 'Move Payments down', exact: true })
      .click();
    await expect(names.nth(0)).toHaveValue('Access');
    await expect
      .poll(async () => (await readEditorDraft(page, path)).graph.edges)
      .toEqual(before);

    await expect
      .poll(async () => {
        const { graph } = await readEditorDraft(page, path);
        return graph.nodes.find(({ id }) => id === source)?.config.categories;
      })
      .toMatchObject([
        { id: 'category-02', label: 'Access' },
        { id: 'category-01', label: 'Payments' },
      ]);
    await expectCategoryLink(page, before, 'category-02', 'Access');
    await expectCategoryLink(page, before, 'category-01', 'Payments');
    await page
      .getByText('Categories', { exact: true })
      .scrollIntoViewIfNeeded();
    await modelScreenshots(page, info, 'classify-categories');

    provider.answerWith({ selectedPort: 'category-01' });
    await checkPinnedPreview(page, source);
    expect(provider.calls).toHaveLength(1);
    await page.getByRole('tab', { name: 'Setup', exact: true }).click();
    await publishSingleStep(page, path);
    const runPage = await page.context().newPage();
    let firstRun: string | undefined;
    for (const [port, label] of [
      ['category-01', 'Billing'],
      ['category-02', 'Access'],
      ['other', 'Other'],
    ] as const) {
      provider.answerWith({ selectedPort: port });
      await runPage.goto(editor);
      const run = await startSingleStep(runPage, {
        message: 'Route this request',
      });
      firstRun ??= run;
      await waitForRun(runPage, workspace, run, 'succeeded');
      await expect(
        runPage.getByRole('button', { name: `Route ${label}: Succeeded` }),
      ).toBeVisible();
      if (port === 'category-01') {
        await runPage
          .getByRole('button', { name: /^Classify request: Succeeded/u })
          .click();
        const detail = runPage.getByRole('complementary', {
          name: 'Step details',
        });
        await expect(detail).toContainText(model);
        await expect(
          detail.getByText('Payments', { exact: true }),
        ).toBeVisible();
        await expect(detail.getByText(port, { exact: true })).toBeVisible();
        await modelScreenshots(runPage, info, 'classify-routed-run');
      }
    }
    expect(provider.calls).toHaveLength(4);
    if (firstRun === undefined) throw new Error('Missing initial routed run');
    await runPage.goto(`/w/${workspace}/runs/${firstRun}`);
    await runPage.getByRole('button', { name: 'Replay', exact: true }).click();
    const replay = runPage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith(`/${firstRun}/replay`),
    );
    await runPage
      .getByRole('dialog', { name: 'Replay this run' })
      .getByRole('button', { name: 'Replay run', exact: true })
      .click();
    const result = workflowRunStartResponseSchema.parse(
      await (await replay).json(),
    );
    await waitForRun(runPage, workspace, result.run.id, 'succeeded');
    await expect(
      runPage.getByRole('button', { name: 'Route Other: Succeeded' }),
    ).toBeVisible();
    expect(provider.calls).toHaveLength(5);

    provider.answerWith({ selectedPort: 'Payments' });
    await runPage.goto(editor);
    const failed = await startSingleStep(runPage, {
      message: 'Route this request',
    });
    await waitForRun(runPage, workspace, failed, 'failed');
    await expect(
      runPage.getByRole('button', { name: /^Route .*: Succeeded/u }),
    ).toHaveCount(0);
    expect(provider.calls).toHaveLength(7);

    await page
      .getByRole('button', { name: 'Remove Payments', exact: true })
      .click();
    await expect
      .poll(async () => (await readEditorDraft(page, path)).graph.edges)
      .toEqual(
        before.filter(
          ({ source: edgeSource }) => edgeSource.port !== 'category-01',
        ),
      );
    await expect(page.getByTestId(`rf__node-${source}`)).toContainText(
      'Pin needs review',
    );
  } finally {
    await provider.close();
  }
});

async function expectCategoryLink(
  page: Page,
  edges: Awaited<ReturnType<typeof readEditorDraft>>['graph']['edges'],
  port: string,
  label: string,
) {
  const edge = edges.find(({ source }) => source.port === port);
  if (edge === undefined) throw new Error(`Missing edge from ${port}`);
  const path = page
    .getByTestId(`rf__edge-${edge.id}`)
    .locator('.react-flow__edge-path');
  const handle = page.getByRole('img', {
    name: `Classify request: output ${label}`,
    exact: true,
  });
  await expect
    .poll(async () => {
      const center = await handle.evaluate((element) => {
        const { y, height } = element.getBoundingClientRect();
        return y + height / 2;
      });
      const endpoint = await path.evaluate((element: SVGPathElement) => {
        const matrix = element.getScreenCTM();
        return matrix === null
          ? Number.NaN
          : element.getPointAtLength(0).matrixTransform(matrix).y;
      });
      return Math.abs(endpoint - center);
    })
    .toBeLessThan(2);
}

async function selectSource(page: Page, source: string) {
  await page.getByTestId(`rf__node-${source}`).focus();
  await page.keyboard.press('Enter');
}

async function checkPinnedPreview(page: Page, source: string) {
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  await page
    .getByLabel('Sample input (JSON)')
    .fill('{"message":"Route this request"}');
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
  await page.getByRole('button', { name: 'Run test', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Test result' })).toContainText(
    'category-01',
  );
  await page
    .getByRole('button', { name: 'Pin test output…', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Pin output', exact: true })
    .click();

  const response = page.waitForResponse(
    (result) =>
      result.request().method() === 'POST' &&
      new URL(result.url()).pathname.endsWith(`/draft/nodes/${source}/test`),
  );
  await page
    .getByRole('button', { name: 'Test with pinned output', exact: true })
    .click();
  const { preview } = nodeTestExecuteAcceptedResponseSchema.parse(
    await (await response).json(),
  );
  expect(preview).toMatchObject({
    status: 'succeeded',
    pinnedSampleId: expect.any(String),
    output: { kind: 'inline', value: { selectedPort: 'category-01' } },
  });
  expect(preview.modelUsage).toBeUndefined();
}
