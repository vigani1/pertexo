import { expect } from '@playwright/test';
import { mapBrowserInput } from '../../../test/support/browser/inputs';
import {
  addSingleStep,
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
  startSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';
import { openNewEditorWorkspace } from '../../support/ordinary-editor-session';
import { publishGraph, saveGraph } from '../callable/fixture';
import { test } from './account';
import { addAgent, choose } from './agent-editor';
import { connectModel, modelScreenshots } from './model-editor';
import { model, openModelProvider } from './model-provider';

const alias = 'verify_order';

test.use({
  accountGroup: 'callable',
  actionTimeout: 10_000,
  viewport: { width: 1280, height: 1280 },
});

test('pins a callable workflow as an Agent tool and opens its child from the inspector', async ({
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
                id: 'look-up-order',
                type: 'function',
                function: {
                  name: alias,
                  arguments: JSON.stringify({ order: 'order-17' }),
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
        { finish_reason: 'stop', message: { content: 'Order 17 verified.' } },
      ],
      usage: { prompt_tokens: 38, completion_tokens: 5 },
    },
  ]);
  try {
    const workspace = await openNewEditorWorkspace(
      page,
      'Agent callable workspace',
    );
    const childPath = await createEditorWorkflow(
      page,
      workspace,
      'Verify order',
    );
    await addSingleStep(page, childPath, /^Manual start\b/u, 'Receive order');
    const draft = await readEditorDraft(page, childPath);
    const input = {
      type: 'object',
      properties: [
        { name: 'order', valueType: { type: 'string' }, required: true },
      ],
    };
    await saveGraph(page, childPath, {
      ...draft.graph,
      callable: {
        input,
        resultType: { type: 'string' },
        result: { kind: 'run_input', path: '$.order' },
      },
    });
    const child = await publishGraph(page, childPath);
    await connectModel(page, workspace);
    const parent = await createEditorWorkflow(
      page,
      workspace,
      'Verify with Agent',
    );
    await addAgent(page, parent, 'Verify an order');
    const setup = page.getByRole('tab', { name: 'Setup', exact: true });
    await setup.click();
    await choose(page, 'AI model connection', 'Order model');
    await page.getByLabel('Model identifier', { exact: true }).fill(model);
    await choose(page, 'Agent tool', 'Call workflow');
    await page.getByLabel('Tool alias', { exact: true }).fill(alias);
    await page
      .getByLabel('Tool description', { exact: true })
      .fill('Verify the order reference');
    await choose(page, 'Child workflow', 'Verify order');
    await choose(page, 'Published version', 'Version 1');
    await choose(page, 'Write approval', 'Allow without approval');
    await expect
      .poll(async () => {
        const { graph } = await readEditorDraft(page, parent);
        const tools = graph.nodes.find(
          ({ definition }) => definition.key === 'ai.agent',
        )?.config.tools;
        return Array.isArray(tools) ? tools[0] : undefined;
      })
      .toMatchObject({
        definition: { key: 'core.call', version: 1 },
        config: {
          input,
          target: {
            workflowId: child.workflowId,
            workflowVersionId: child.id,
            executableChecksum: child.checksum,
          },
        },
        writePermission: { kind: 'allow' },
      });
    await mapBrowserInput({
      page,
      field: 'prompt',
      source: 'Run input',
      path: '$.task',
    });
    await setup.click();
    await page
      .getByLabel('Write approval', { exact: true })
      .scrollIntoViewIfNeeded();
    await modelScreenshots(page, info, 'agent-call-setup');
    await publishSingleStep(page, parent);
    const runId = await startSingleStep(page, { task: 'Verify order 17' });
    const run = await waitForRun(page, workspace, runId, 'succeeded');
    expect(run.calls).toMatchObject([
      { targetVersionId: child.id, status: 'succeeded' },
    ]);
    await page.getByRole('button', { name: /^Verify an order\b/u }).click();
    const activity = page.getByRole('region', { name: 'Agent activity' });
    const link = activity.getByRole('link', {
      name: 'Open child run',
      exact: true,
    });
    await expect(link).toHaveAttribute(
      'href',
      `/w/${workspace}/runs/${run.calls?.[0]?.childRunId ?? ''}`,
    );
    await modelScreenshots(page, info, 'agent-call-inspector');
    await link.click();
    await expect(
      page.getByRole('link', { name: 'Open parent run', exact: true }),
    ).toHaveAttribute('href', `/w/${workspace}/runs/${runId}`);
  } finally {
    await provider.close();
  }
});
