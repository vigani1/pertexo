import { dataTableCreatedSchema } from '@pertexo/contracts';
import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mapBrowserInput } from '../../../test/support/browser/inputs';
import { readCsrfToken } from '../../../test/support/browser/csrf';
import {
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
  startSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';
import {
  openNewEditorWorkspace,
  createVerifiedEditorUser,
} from '../../support/ordinary-editor-session';
import { addAgent, choose } from './agent-editor';
import { test } from './account';
import { connectModel, modelScreenshots } from './model-editor';
import { model, openModelProvider } from './model-provider';

const alias = 'find_orders';

test.use({
  accountGroup: 'assistant',
  actionTimeout: 10_000,
  viewport: { width: 1280, height: 1280 },
});

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
    await expect(detail).toContainText('Workspace table Orders');
    await expect(detail).toContainText('Attempt 1 succeeded');
    await expect(detail).toContainText('shipped');
  } finally {
    await provider.close();
  }
});
test('configures, approves and reviews an Agent write tool', async ({
  browser,
  page: owner,
  productAccount,
}, info) => {
  const mail = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  const { baseURL } = info.project.use;
  if (mail === undefined || baseURL === undefined)
    throw new Error('Owned browser fixture missing');
  const provider = await openModelProvider([
    {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [
              {
                id: 'insert-order',
                type: 'function',
                function: {
                  name: 'insert_order',
                  arguments: JSON.stringify({
                    values: { key: 'order-19', status: 'ready' },
                  }),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 24, completion_tokens: 8 },
    },
    {
      choices: [
        { finish_reason: 'stop', message: { content: 'Order 19 is ready.' } },
      ],
      usage: { prompt_tokens: 38 },
    },
  ]);
  try {
    const ownerEmail = productAccount.email;
    const workspace = await openNewEditorWorkspace(
      owner,
      'Agent write workspace',
    );
    await seedOrders(owner, workspace);
    await connectModel(owner, workspace);
    const path = await createEditorWorkflow(owner, workspace, 'Insert orders');
    const editorUrl = new URL(owner.url()).pathname;
    await addAgent(owner, path, 'Record an order');
    await owner.getByRole('tab', { name: 'Setup', exact: true }).click();
    await choose(owner, 'AI model connection', 'Order model');
    await owner.getByLabel('Model identifier', { exact: true }).fill(model);
    await choose(owner, 'Agent tool', 'Insert row');
    await owner.getByLabel('Tool alias', { exact: true }).fill('insert_order');
    await owner
      .getByLabel('Tool description', { exact: true })
      .fill('Record a new order in Orders');
    await choose(owner, 'Workspace table', 'Orders');
    await choose(owner, 'Write approval', 'Require approval');
    await owner
      .getByLabel('Request title', { exact: true })
      .fill('Order 19 insertion');
    await expect(
      owner.getByRole('group', { name: 'Who can decide' }),
    ).toBeVisible();
    await owner
      .getByRole('checkbox', {
        name: 'Let the person who started the run decide',
      })
      .check();
    await mapBrowserInput({
      page: owner,
      field: 'prompt',
      source: 'Run input',
      path: '$.task',
    });
    await owner.getByRole('tab', { name: 'Setup', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await readEditorDraft(owner, path)).graph.nodes.find(
            ({ definition }) => definition.key === 'ai.agent',
          )?.config.tool,
      )
      .toMatchObject({
        writePermission: { config: { title: 'Order 19 insertion' } },
      });
    await owner
      .getByRole('checkbox', {
        name: 'Let the person who started the run decide',
      })
      .scrollIntoViewIfNeeded();
    await modelScreenshots(owner, info, 'agent-write-setup');
    await publishSingleStep(owner, path);
    const run = await startSingleStep(owner, { task: 'Record order 19' });
    await waitForRun(owner, workspace, run, 'waiting');
    await owner.getByRole('button', { name: /^Record an order:/u }).click();
    const activity = owner.getByRole('region', { name: 'Agent activity' });
    await expect(
      activity.getByText('Awaiting approval', { exact: true }),
    ).toBeVisible();
    await owner
      .getByRole('button', { name: 'Approve Order 19 insertion', exact: true })
      .click();
    await waitForRun(owner, workspace, run, 'succeeded');
    await expect(
      activity.getByRole('button', {
        name: 'Insert row · insert_order',
        exact: true,
      }),
    ).toBeVisible();
    await expect(activity.getByText('Approved', { exact: true })).toBeVisible();
    await modelScreenshots(owner, info, 'agent-write-inspector');
    const reviewer = await browser.newContext({ baseURL });
    try {
      const person = await reviewer.newPage();
      const viewerEmail = await createVerifiedEditorUser(
        person,
        person.request,
        mail,
        'Agent write reviewer',
      );
      const workflowId = path.split('/').at(-1);
      const enrolled = await owner.request.post(`${mail}/readonly-setup`, {
        data: { workspaceId: workspace, workflowId, ownerEmail, viewerEmail },
      });
      expect(enrolled.status()).toBe(200);
      const { viewerId } = (await enrolled.json()) as { viewerId: string };
      const role = await owner.request.post(
        `/v1/workspaces/${workspace}/members/${viewerId}/role`,
        {
          headers: await commandHeaders(owner),
          data: { role: 'admin', expectedRoleRevision: 1 },
        },
      );
      expect(role.status(), await role.text()).toBe(200);
    } finally {
      await reviewer.close();
    }
    await owner.goto(`/w/${workspace}/settings/audit`);
    await owner
      .getByRole('checkbox', { name: 'Require approval to publish' })
      .check();
    await owner
      .getByRole('button', { name: 'Save publishing policy', exact: true })
      .click();
    await expect(
      owner.getByText('Publishing policy saved.', { exact: true }),
    ).toBeVisible();
    await owner.goto(editorUrl);
    const agent = (await readEditorDraft(owner, path)).graph.nodes.find(
      ({ definition }) => definition.key === 'ai.agent',
    );
    if (agent === undefined) throw new Error('Agent step missing');
    await owner.getByTestId(`rf__node-${agent.id}`).focus();
    await owner.keyboard.press('Enter');
    await owner.getByRole('tab', { name: 'Setup', exact: true }).click();
    await choose(owner, 'Write approval', 'Allow without approval');
    await owner
      .getByRole('button', { name: 'Request review', exact: true })
      .click();
    const dialog = owner.getByRole('dialog', {
      name: 'Request publication review',
      exact: true,
    });
    await dialog
      .getByLabel('Note for the reviewer')
      .fill('Review the Agent rule for writing orders.');
    await dialog
      .getByRole('button', { name: 'Request review', exact: true })
      .click();
    const review = owner.getByRole('region', { name: 'Reviewed draft' });
    await expect(review).toContainText('Allowed without approval');
    await expect(review).toContainText('Insert row · insert_order');
    await expect(review).toContainText('Workspace table Orders');
    await modelScreenshots(owner, info, 'agent-write-review');
  } finally {
    await provider.close();
  }
});

async function commandHeaders(page: Page) {
  return {
    'x-csrf-token': await readCsrfToken(page),
    'Idempotency-Key': randomUUID(),
  };
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
