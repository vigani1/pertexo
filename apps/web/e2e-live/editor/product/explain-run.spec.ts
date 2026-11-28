import { mapBrowserInput } from '../../../test/support/browser/inputs';
import { expect } from '@playwright/test';
import { test } from './account';
import {
  addSingleStep,
  createEditorWorkflow,
  publishSingleStep,
  startSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';
import { openNewEditorWorkspace } from '../../support/ordinary-editor-session';
import {
  connectModel,
  enableAssistant,
  modelScreenshots,
} from './model-editor';
import { key, model, openModelProvider } from './model-provider';

test.use({ accountGroup: 'assistant', viewport: { width: 1280, height: 960 } });

test('confirms the transfer and follows an authorized step from the explanation', async ({
  page,
}, info) => {
  const inference = await openModelProvider();
  try {
    const workspace = await openNewEditorWorkspace(page, 'Assistant workspace');
    await connectModel(page, workspace);
    const path = await createEditorWorkflow(
      page,
      workspace,
      'Diagnose an order',
    );
    const stepId = await addSingleStep(
      page,
      path,
      /^AI Model/u,
      'Extract order',
    );
    await page.getByRole('tab', { name: 'Setup', exact: true }).click();
    await page.getByLabel('Model identifier', { exact: true }).fill(model);
    await page.getByLabel('AI model connection', { exact: true }).click();
    await page
      .getByRole('option', { name: 'Order model', exact: true })
      .click();
    await mapBrowserInput({
      page,
      field: 'prompt',
      source: 'Run input',
      path: '$.sentinel',
    });
    // A refused step records a safe failure code and leaves the run payload in storage.
    inference.refuse();
    await publishSingleStep(page, path);
    const sentinel = 'assistant-run-payload-must-stay-local';
    const run = await startSingleStep(page, { sentinel });
    await waitForRun(page, workspace, run, 'failed');
    const open = page.getByRole('button', {
      name: 'Explain failed run',
      exact: true,
    });
    const disclosure = page.getByRole('dialog', { name: 'Explain failed run' });
    await open.click();
    await expect(disclosure).toContainText('Ask a workspace administrator');
    await disclosure
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();

    await enableAssistant(page, workspace, model);
    await page.goto(`/w/${workspace}/runs/${run}`);

    inference.answerWith({
      explanation: 'The model refused to answer during Extract order.',
      stepIds: [stepId, 'invented-step'],
    });
    const callCount = inference.calls.length;
    await open.click();
    await expect(disclosure).toContainText('model.provider.test');
    await expect(disclosure).toContainText('safe error code');
    expect(inference.calls).toHaveLength(callCount);
    await modelScreenshots(page, info, 'assistant-disclosure');
    await disclosure.getByRole('button', { name: 'Send to model' }).click();
    const explanation = page.getByRole('dialog', { name: 'Run explanation' });
    await expect(explanation).toContainText(
      'The model refused to answer during Extract order.',
    );
    await expect(explanation).toContainText(model);
    await expect(
      explanation.getByRole('button', { name: 'invented-step' }),
    ).toHaveCount(0);
    expect(inference.calls).toHaveLength(callCount + 1);
    const request = JSON.stringify(inference.calls.at(-1));
    expect(request).toContain('model.output_refused');
    expect(request).not.toContain(key);
    expect(request).not.toContain(sentinel);
    await modelScreenshots(page, info, 'assistant-explanation');
    await page.setViewportSize({ width: 390, height: 844 });
    const linkedStep = page.getByRole('dialog', { name: 'Extract order' });
    await expect(linkedStep).toBeHidden();
    await explanation
      .getByRole('button', { name: 'Extract order', exact: true })
      .click();
    await expect(linkedStep).toContainText(
      'The model refused to answer the prompt.',
    );
  } finally {
    await inference.close();
  }
});
