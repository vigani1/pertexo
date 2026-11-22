import { dataTableCreatedSchema } from '@pertexo/contracts';
import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mapBrowserInput } from '../../../test/support/browser/inputs';
import { readCsrfToken } from '../../../test/support/browser/csrf';
import {
  addSingleStep,
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
  startSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';
import { openNewEditorWorkspace } from '../../support/ordinary-editor-session';
import { test } from './account';
import { connectModel, modelScreenshots } from './model-editor';
import { model, openModelProvider } from './model-provider';

const alias = 'find_orders';

test.use({ actionTimeout: 10_000, viewport: { width: 1280, height: 1280 } });

test('publishes an Agent with a Find rows tool and inspects its work', async ({
  page,
}, info) => {
  const provider = await openModelProvider([
    {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [
              {
                id: 'selected-order',
                type: 'function',
                function: {
                  name: alias,
                  arguments: JSON.stringify({
                    query: {
                      filters: [
                        {
                          column: 'key',
                          operator: 'equals',
                          value: 'order-17',
                        },
                      ],
                      limit: 1,
                    },
                  }),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 23, completion_tokens: 7 },
    },
    {
      choices: [
        {
          finish_reason: 'stop',
          message: { content: 'Order 17 has shipped.' },
        },
      ],
      usage: { prompt_tokens: 38 },
    },
  ]);
  try {
    const workspace = await openNewEditorWorkspace(page, 'Agent workspace');
    await seedOrders(page, workspace);
    await connectModel(page, workspace);
    const path = await createEditorWorkflow(page, workspace, 'Look up orders');
    await addAgent(page, path);
    const setup = page.getByRole('tab', { name: 'Setup', exact: true });
    await setup.click();
    await page.getByLabel('AI model connection', { exact: true }).click();
    await page
      .getByRole('option', { name: 'Order model', exact: true })
      .click();
    await page.getByLabel('Model identifier', { exact: true }).fill(model);
    await page.getByLabel('Tool alias', { exact: true }).fill(alias);
    await page
      .getByLabel('Tool description', { exact: true })
      .fill('Find an order and its status');
    await page.getByLabel('Workspace table', { exact: true }).click();
    await page.getByRole('option', { name: 'Orders', exact: true }).click();
    await mapBrowserInput({
      page,
      field: 'prompt',
      source: 'Run input',
      path: '$.task',
    });
    await mapBrowserInput({
      page,
      field: 'input',
      source: 'Run input',
      path: '$.order',
    });
    await setup.click();
    await expect(
      page
        .getByRole('tabpanel', { name: 'Setup' })
        .getByText(/bounded tool results enter the model request/u),
    ).toBeVisible();
    await page
      .getByLabel('Model identifier', { exact: true })
      .scrollIntoViewIfNeeded();
    await modelScreenshots(page, info, 'agent-setup');

    await publishSingleStep(page, path);
    const run = await startSingleStep(page, {
      task: 'Look up the order',
      order: { key: 'order-17' },
    });
    await waitForRun(page, workspace, run, 'succeeded');
    expect(provider.calls).toHaveLength(2);
    expect(JSON.stringify(provider.calls[0])).toContain('order-17');
    expect(JSON.stringify(provider.calls[1])).toContain('shipped');
    const agent = page.getByRole('button', {
      name: /^Look up an order: Succeeded/u,
    });
    await agent.click();
    const detail = page.getByRole('complementary', { name: 'Step details' });
    const activity = detail.getByRole('region', { name: 'Agent activity' });
    await expect(activity.getByRole('button')).toHaveText([
      'Model turn 1',
      'Find rows · find_orders',
      'Model turn 2',
    ]);
    await expect(detail).toContainText('Order 17 has shipped.');
    await expect(activity).toContainText('Usage is incomplete.');
    await modelScreenshots(page, info, 'agent-inspector');
    await activity
      .getByRole('button', { name: 'Model turn 1', exact: true })
      .click();
    await expect(detail).toContainText('Input tokens');
    await expect(detail).toContainText('Look up the order');
    await agent.click();
    await activity
      .getByRole('button', { name: 'Model turn 2', exact: true })
      .click();
    await expect(detail).toContainText('Usage is incomplete.');
    await agent.click();
    await activity
      .getByRole('button', { name: 'Find rows · find_orders', exact: true })
      .click();
    await expect(detail).toContainText('Attempt 1 succeeded');
    await expect(detail).toContainText('shipped');
  } finally {
    await provider.close();
  }
});

async function addAgent(page: Page, path: string) {
  await addSingleStep(page, path, /^Manual start\b/u, 'Start');
  await page.getByRole('button', { name: 'Step actions', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Add step after', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Add a step after “Start”' })
    .getByRole('button', { name: /^Agent\b/u })
    .click();
  await expect
    .poll(async () => (await readEditorDraft(page, path)).graph.edges.length)
    .toBe(1);
  const { graph } = await readEditorDraft(page, path);
  const agent = graph.nodes.find(
    ({ definition }) => definition.key === 'ai.agent',
  );
  if (agent === undefined) throw new Error('Browser-authored Agent is missing');
  await page.getByTestId(`rf__node-${agent.id}`).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Label', { exact: true }).fill('Look up an order');
  await page.keyboard.press('Tab');
}

async function seedOrders(page: Page, workspace: string) {
  const csrf = await readCsrfToken(page, {
    missingMessage: 'Owned CSRF cookie missing',
  });
  const headers = () => ({
    'x-csrf-token': csrf,
    'Idempotency-Key': randomUUID(),
  });
  const path = `/v1/workspaces/${workspace}/data-tables`;
  const created = await page.request.post(path, {
    headers: headers(),
    data: {
      name: 'Orders',
      columns: [
        { name: 'key', type: 'text', required: true },
        { name: 'status', type: 'text', required: true },
      ],
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = dataTableCreatedSchema.parse(await created.json());
  const seeded = await page.request.post(`${path}/${id}/import`, {
    headers: headers(),
    data: { csv: 'key,status\norder-17,shipped\norder-18,pending' },
  });
  expect(seeded.status(), await seeded.text()).toBe(200);
}
