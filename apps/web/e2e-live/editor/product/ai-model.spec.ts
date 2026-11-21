import {
  nodeTestExecuteAcceptedResponseSchema,
  workflowRunStartResponseSchema,
} from '@pertexo/contracts';
import { expect, type Page, type TestInfo } from '@playwright/test';
import {
  addBrowserInput,
  mapBrowserInput,
} from '../../../test/support/browser/inputs';
import { test } from './account';
import { baseUrl, key, model, openModelProvider } from './model-provider';
import { openNewEditorWorkspace } from '../../support/ordinary-editor-session';
import { fillOwnedHttpCredential } from '../../support/http-secret-actions';
import {
  addSingleStep,
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
  startSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';

test.use({ actionTimeout: 10_000, viewport: { width: 1280, height: 960 } });

test('extracts data, measures inference and replays with a fresh model call', async ({
  page,
}, info) => {
  const provider = await openModelProvider();
  try {
    const workspace = await openNewEditorWorkspace(page, 'Model workspace');
    await connectModel(page, workspace);
    expect(provider.probes.length).toBeGreaterThan(0);
    expect(provider.calls).toHaveLength(0);
    const path = await createEditorWorkflow(
      page,
      workspace,
      'Extract an order',
    );
    const editor = new URL(page.url()).pathname;
    const source = await addSingleStep(
      page,
      path,
      /^AI Model/u,
      'Extract order',
    );
    await configureModel(page);
    await mapBrowserInput({
      page,
      field: 'prompt',
      source: 'Run input',
      path: '$.prompt',
    });
    await page.getByRole('tab', { name: 'Setup', exact: true }).click();
    await page.getByLabel('Mode', { exact: true }).scrollIntoViewIfNeeded();
    await screenshots(page, info, 'model-setup');
    await page.getByRole('tab', { name: 'Test', exact: true }).click();
    await page
      .getByLabel('Sample input (JSON)')
      .fill('{"prompt":"Find the order reference."}');
    await page
      .getByRole('button', { name: 'Check setup', exact: true })
      .click();
    await expect(
      page.getByText('Setup looks right', { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('tabpanel', { name: 'Test', exact: true })
        .getByText(
          'This sends the mapped prompt to the model provider. Inference can incur charges.',
          { exact: true },
        ),
    ).toBeVisible();
    await page
      .getByRole('switch', {
        name: 'I understand this test runs for real',
        exact: true,
      })
      .check();
    await page.getByRole('button', { name: 'Run test', exact: true }).click();
    const result = page.getByRole('region', { name: 'Test result' });
    await expect(result).toContainText('order-17');
    await expect(result).toContainText(model);
    expect(provider.calls).toHaveLength(1);
    await addConsumer(page, path, source);
    await publishSingleStep(page, path);
    const input = { prompt: 'Find the order reference.' };
    const runPage = await page.context().newPage();
    await runPage.goto(editor);
    const run = await startSingleStep(runPage, input);
    await waitForRun(runPage, workspace, run, 'succeeded');
    const detail = runPage.getByRole('complementary', { name: 'Step details' });
    await runPage
      .getByRole('button', { name: /^Read order: Succeeded/u })
      .click();
    await expect(detail).toContainText('order-17');
    await runPage
      .getByRole('button', { name: /^Extract order: Succeeded/u })
      .click();
    await expect(detail).toContainText(model);
    await expect(detail.getByText('23', { exact: true })).toBeVisible();
    await expect(detail.getByText('7', { exact: true })).toBeVisible();
    await screenshots(runPage, info, 'model-usage');
    expect(provider.calls).toHaveLength(2);

    await pinAndTest(page, source);
    expect(provider.calls).toHaveLength(2);

    await runPage.goto(`/w/${workspace}/runs/${run}`);
    await runPage.getByRole('button', { name: 'Replay', exact: true }).click();
    const replay = runPage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith(`/${run}/replay`),
    );
    await runPage
      .getByRole('dialog', { name: 'Replay this run' })
      .getByRole('button', { name: 'Replay run', exact: true })
      .click();
    const replayed = workflowRunStartResponseSchema.parse(
      await (await replay).json(),
    );
    await waitForRun(runPage, workspace, replayed.run.id, 'succeeded');
    expect(provider.calls).toHaveLength(3);

    provider.refuse();
    await runPage.goto(editor);
    const failed = await startSingleStep(runPage, input);
    await waitForRun(runPage, workspace, failed, 'failed');
    await runPage
      .getByRole('button', { name: /^Extract order: Failed/u })
      .click();
    await expect(detail).toContainText(
      'The model refused to answer the prompt.',
    );
    await expect(detail).toContainText('Usage is incomplete.');
    await expect(detail.getByText('Unknown', { exact: true })).toBeVisible();
    await screenshots(runPage, info, 'model-error');
  } finally {
    await provider.close();
  }
});

async function connectModel(page: Page, workspace: string) {
  await page.goto(`/w/${workspace}/connections`);
  await page
    .getByRole('button', { name: 'Add connection', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Add a connection', exact: true })
    .getByRole('button', { name: 'Connect AI', exact: true })
    .click();
  const form = page.getByRole('dialog', { name: 'Connect AI', exact: true });
  await form.getByRole('radio', { name: 'Ollama', exact: true }).click();
  const url = form.getByLabel('API base URL', { exact: true });
  await expect(url).toHaveAttribute('aria-required', 'true');
  await form.getByRole('radio', { name: 'vLLM', exact: true }).click();
  await expect(url).toHaveAttribute('aria-required', 'true');
  await url.fill(baseUrl);
  const secret = form.getByLabel('API key', { exact: true });
  await expect(secret).toHaveAttribute('type', 'password');
  await fillOwnedHttpCredential(secret, key);
  await form.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Connection name', { exact: true }).fill('Order model');
  await page
    .getByRole('button', { name: 'Save and test', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Test connection', exact: true })
    .click();
  await expect(
    page.getByText('AI accepted the API key.', { exact: true }),
  ).toBeVisible();
}

async function configureModel(page: Page) {
  await page.getByRole('tab', { name: 'Setup', exact: true }).click();
  const mode = page.getByLabel('Mode', { exact: true });
  await expect(mode).toHaveText('Generate text');
  const identifier = page.getByLabel('Model identifier', { exact: true });
  await expect(identifier).toHaveAttribute('aria-required', 'true');
  await expect(identifier).toHaveValue('');
  await identifier.fill(model);
  await page.getByLabel('AI model connection', { exact: true }).click();
  await page.getByRole('option', { name: 'Order model', exact: true }).click();
  await mode.click();
  await page
    .getByRole('option', { name: 'Extract structured data', exact: true })
    .click();
  await expect(identifier).toHaveValue(model);
  const schema = page.getByLabel('Output schema', { exact: true });
  await schema.fill('{"type":"object","$ref":"#"}');
  await schema.blur();
  await expect(schema).toHaveAccessibleDescription(/unsupported/u);
  await schema.fill(
    JSON.stringify(
      {
        type: 'object',
        properties: { order: { type: 'string' } },
        required: ['order'],
        additionalProperties: false,
      },
      null,
      2,
    ),
  );
  await schema.blur();
}

async function addConsumer(page: Page, path: string, source: string) {
  await page.getByRole('button', { name: 'Step actions', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Add step after', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Add a step after “Extract order”' })
    .getByRole('button', { name: /Set fields/u })
    .click();
  await expect
    .poll(async () => (await readEditorDraft(page, path)).graph.nodes.length)
    .toBe(2);
  const consumer = (await readEditorDraft(page, path)).graph.nodes.find(
    (step) => step.id !== source,
  );
  if (consumer === undefined) throw new Error('Downstream step missing');
  await selectStep(page, consumer.id);
  await page.getByLabel('Label', { exact: true }).fill('Read order');
  await page.keyboard.press('Tab');
  await addBrowserInput({
    page,
    key: 'reference',
    source: async (row) => {
      await row
        .getByRole('button', { name: 'Step output', exact: true })
        .click();
      await row.getByLabel('Source step', { exact: true }).click();
      await page
        .getByRole('option', { name: 'Extract order', exact: true })
        .click();
      await row.getByLabel('Output path', { exact: true }).fill('$.data.order');
    },
  });
}

async function selectStep(page: Page, id: string) {
  await page.getByTestId(`rf__node-${id}`).focus();
  await page.keyboard.press('Enter');
}

async function pinAndTest(page: Page, source: string) {
  await selectStep(page, source);
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  await page
    .getByRole('button', { name: 'Pin test output…', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Pin output', exact: true })
    .click();
  const testResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith(`/draft/nodes/${source}/test`),
  );
  await page
    .getByRole('button', { name: 'Test with pinned output', exact: true })
    .click();
  const accepted = nodeTestExecuteAcceptedResponseSchema.parse(
    await (await testResponse).json(),
  );
  expect(accepted.preview).toMatchObject({
    status: 'succeeded',
    pinnedSampleId: expect.any(String),
    output: { kind: 'inline', value: { data: { order: 'order-17' } } },
  });
  expect(accepted.preview.modelUsage).toBeUndefined();
}

async function screenshots(page: Page, info: TestInfo, title: string) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      colorScheme,
    );
    await page.screenshot({
      path: info.outputPath(`${title}-${colorScheme}.png`),
    });
  }
}
