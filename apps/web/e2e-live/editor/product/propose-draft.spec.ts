import { expect, type Page } from '@playwright/test';
import { test } from './account';
import { connectModel, modelScreenshots } from './model-editor';
import { key, model, openModelProvider } from './model-provider';
import {
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
} from '../../support/authoring/single-step';
import { openNewEditorWorkspace } from '../../support/ordinary-editor-session';

test.use({ viewport: { width: 1280, height: 960 } });

const manual = {
  id: 'order-start',
  label: 'Start order intake',
  definition: { key: 'core.manual', version: 1 },
  configVersion: 1,
  position: { x: 0, y: 0 },
  config: {},
  inputMappings: {},
  connectionRefs: {},
};
const prepare = {
  ...manual,
  id: 'prepare-order',
  label: 'Prepare order',
  definition: { key: 'core.set', version: 1 },
  position: { x: 300, y: 0 },
};
const graph = {
  nodes: [manual, prepare],
  edges: [
    {
      id: 'order-start-prepare',
      source: { nodeId: manual.id, port: 'out' },
      target: { nodeId: prepare.id, port: 'in' },
    },
  ],
  settings: {},
};
const edited = {
  ...graph,
  nodes: [manual, { ...prepare, label: 'Normalize order' }],
};
const incomplete = {
  ...edited,
  nodes: [
    ...edited.nodes,
    {
      ...prepare,
      id: 'send-order',
      label: 'Send order',
      definition: { key: 'http.request', version: 1 },
      position: { x: 600, y: 0 },
    },
  ],
  edges: [
    ...edited.edges,
    {
      id: 'prepare-order-send',
      source: { nodeId: prepare.id, port: 'out' },
      target: { nodeId: 'send-order', port: 'in' },
    },
  ],
};

test('reviews, applies and publishes a draft chosen from the catalog', async ({
  page,
}, info) => {
  const inference = await openModelProvider([
    toolReply('search_catalog', { query: 'manual' }, 1),
    toolReply('get_step_details', { key: 'core.manual', version: 1 }, 2),
    toolReply('propose_draft', { graph }, 3),
    toolReply('propose_draft', { graph: edited }, 4),
    toolReply('propose_draft', { graph: incomplete }, 5),
  ]);
  try {
    const workspace = await openNewEditorWorkspace(
      page,
      'Draft assistant workspace',
    );
    await connectModel(page, workspace);
    await page.goto(`/w/${workspace}/settings`);
    await page.getByLabel('AI connection', { exact: true }).click();
    await page
      .getByRole('option', { name: 'Order model', exact: true })
      .click();
    await page.getByLabel('Model identifier', { exact: true }).fill(model);
    await page.getByRole('button', { name: 'Save assistant settings' }).click();
    await expect(
      page.getByText('Assistant is on.', { exact: true }),
    ).toBeVisible();
    const path = await createEditorWorkflow(page, workspace, 'Intake orders');
    const draft = await readEditorDraft(page, path);
    expect(draft.graph.nodes).toEqual([]);
    const startPicker = page.getByText('Start with a trigger', { exact: true });
    await expect(startPicker).toBeVisible();
    const request = await openProposal(
      page,
      'Start a manual workflow and prepare the order.',
    );
    await expect(startPicker).toHaveCount(0);
    const backdrop = page.locator('[data-open].scrim');
    await expect(backdrop).toBeVisible();
    await expect(backdrop).toHaveCSS('background-color', /rgba\(/u);
    expect(inference.calls).toHaveLength(0);
    await modelScreenshots(page, info, 'draft-proposal-request');
    await request.getByRole('button', { name: 'Send to model' }).click();
    const review = page.getByRole('dialog', { name: 'Review proposed draft' });
    await expect(review).toContainText('Prepare order');
    await expect(review).toContainText(
      'Start order intake (out) → Prepare order (in)',
    );
    expect(inference.calls).toHaveLength(3);
    expect(JSON.stringify(inference.calls)).not.toContain(key);
    expect(await readEditorDraft(page, path)).toEqual(draft);
    await expect(backdrop).toBeVisible();
    await modelScreenshots(page, info, 'draft-proposal-diff');
    await review.getByRole('button', { name: 'Apply to draft' }).click();
    await expect(review).toBeHidden();
    expect((await readEditorDraft(page, path)).graph).toEqual(graph);
    const versions = await page.request.get(`${path}/versions`);
    expect(await versions.json()).toMatchObject({ items: [] });
    expect((await publishSingleStep(page, path)).versionNumber).toBe(1);

    const edit = await openProposal(
      page,
      'Rename Prepare order to Normalize order.',
    );
    await edit.getByRole('button', { name: 'Send to model' }).click();
    await expect(review).toContainText('Normalize order');
    expect((await readEditorDraft(page, path)).graph).toEqual(graph);
    await review.getByRole('button', { name: 'Apply to draft' }).click();
    await expect(review).toBeHidden();
    expect((await readEditorDraft(page, path)).graph).toEqual(edited);

    const missing = await openProposal(
      page,
      'Add an HTTP request with settings to fill in later.',
    );
    await missing.getByRole('button', { name: 'Send to model' }).click();
    const issues = review.getByRole('list', { name: 'Issues by step' });
    await expect(issues).toContainText('Send order');
    await expect(issues).toContainText('URL needs a value.');
    await expect(issues).not.toContainText('timeoutMillis');
    await expect(backdrop).toBeVisible();
    await modelScreenshots(page, info, 'draft-proposal-issues');
    await page.keyboard.press('Escape');
    await expect(review).toBeHidden();
    await expect(
      page.getByRole('button', { name: 'Ask assistant' }),
    ).toBeFocused();
    expect((await readEditorDraft(page, path)).graph).toEqual(edited);
  } finally {
    await inference.close();
  }
});

async function openProposal(page: Page, description: string) {
  await page
    .getByRole('button', { name: 'Ask assistant', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Describe your workflow change',
  });
  await expect(dialog).toContainText('model.provider.test');
  await expect(dialog).toContainText('filtered draft structure');
  await dialog.getByLabel('What should the workflow do?').fill(description);
  return dialog;
}

function toolReply(name: string, args: object, sequence: number) {
  return {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [
            {
              id: `proposal-${String(sequence)}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 10 },
  };
}
