import { expect } from '@playwright/test';
import { test } from './account';
import { modelScreenshots } from './model-editor';
import {
  checkRouting,
  connectAssistant,
  openProposal,
  orderDraft,
  reviewAndApply,
} from './draft-assistant';
import { key, model, openModelProvider } from './model-provider';
import {
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
} from '../../support/authoring/single-step';
import { openNewEditorWorkspace } from '../../support/ordinary-editor-session';

test.use({ viewport: { width: 1280, height: 960 } });

const graph = orderDraft;
const [manual, prepare] = graph.nodes;
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
    modelReply({ draft: graph }),
    modelReply({ draft: edited }),
    modelReply({ draft: incomplete }),
  ]);
  try {
    const workspace = await openNewEditorWorkspace(
      page,
      'Draft assistant workspace',
    );
    await connectAssistant(page, workspace, model);
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
    expect(inference.calls).toHaveLength(1);
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

const routingRequest =
  'When I start this myself, only flag billing orders as high priority. Leave all other orders alone.';

test('looks up a missing routing step and runs both paths of the proposed workflow', async ({
  page,
}, info) => {
  const route = {
    ...prepare,
    id: 'route',
    label: 'Route by category',
    definition: { key: 'core.switch', version: 2 },
    config: { cases: [{ id: 'case-01', equals: 'billing' }] },
    inputMappings: { value: { kind: 'run_input', path: '$.category' } },
  };
  const draft = {
    ...graph,
    nodes: [
      manual,
      route,
      {
        ...prepare,
        position: { x: 600, y: 0 },
        inputMappings: { priority: { kind: 'literal', value: 'high' } },
      },
    ],
    edges: [
      {
        id: 'start-route',
        source: { nodeId: manual.id, port: 'out' },
        target: { nodeId: route.id, port: 'in' },
      },
      {
        id: 'route-flag',
        source: { nodeId: route.id, port: 'case-01' },
        target: { nodeId: prepare.id, port: 'in' },
      },
    ],
  };
  const inference = await openModelProvider([
    modelReply({ catalogLookup: 'Switch' }),
    modelReply({ draft }),
  ]);
  try {
    const workspace = await openNewEditorWorkspace(page, 'Draft routing');
    await connectAssistant(page, workspace, model);
    const path = await createEditorWorkflow(page, workspace, 'Route orders');
    await reviewAndApply(page, {
      description: routingRequest,
      inference,
      info,
      path,
      modelName: model,
    });
    expect(inference.calls).toHaveLength(2);
    expect(JSON.stringify(inference.calls[0])).not.toContain('core.switch');
    expect(JSON.stringify(inference.calls[1])).toContain('core.switch');
    await checkRouting(page, workspace, path);
  } finally {
    await inference.close();
  }
});

function modelReply(value: unknown) {
  return {
    choices: [
      {
        finish_reason: 'stop',
        message: { content: JSON.stringify(value) },
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 10 },
  };
}
