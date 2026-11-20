import { createServer } from 'node:http';
import { expect } from '@playwright/test';
import {
  workflowRunListResponseSchema,
  workflowNodeRunInputResponseSchema,
  workflowSummaryResponseSchema,
} from '@pertexo/contracts';
import { TRIGGER_INTERVAL_MINUTES } from '@pertexo/workflow-model';
import { test } from '../support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
} from '../support/ordinary-editor-session';
import {
  addSingleStep,
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
  waitForRun,
} from '../support/authoring/single-step';
import { mapBrowserInput } from '../../test/support/browser/inputs';

test('publishes an HTTP feed trigger and passes only the new item to the next step', async ({
  page,
  request,
}) => {
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Use the owned API fixture');
  const items = [{ id: 'baseline', status: 'already present' }];
  const feed = createServer((_req, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(items));
  });
  await new Promise<void>((resolve, reject) => {
    feed.once('error', reject);
    feed.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = feed.address();
    if (address === null || typeof address === 'string')
      throw new Error('The test feed has no TCP address');
    await registerEditorUser(page, request, mailOrigin, 'Polling owner');
    const workspaceId = await createEditorWorkspace(page, 'Polling feed');
    const path = await createEditorWorkflow(
      page,
      workspaceId,
      'Track new items',
    );
    const workflowUrl = new URL(page.url()).pathname;
    const triggerId = await addSingleStep(
      page,
      path,
      /HTTP Polling/u,
      'Watch feed',
    );
    await page
      .getByLabel('Feed URL', { exact: true })
      .fill(`http://127.0.0.1:${String(address.port)}/items`);
    await expect(page.getByLabel('Items path', { exact: true })).toHaveValue(
      '$',
    );
    await expect(page.getByLabel('Item key path', { exact: true })).toHaveValue(
      '$.id',
    );
    await expect(
      page.getByLabel('Check every (minutes)', { exact: true }),
    ).toHaveValue(String(TRIGGER_INTERVAL_MINUTES.minimum));
    await page.keyboard.press('Tab');

    await page
      .getByRole('button', { name: 'Step actions', exact: true })
      .click();
    await page
      .getByRole('menuitem', { name: 'Add step after', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Add a step after “Watch feed”' })
      .getByRole('button', { name: /Set fields/u })
      .click();
    const draft = () => readEditorDraft(page, path);
    await expect.poll(async () => (await draft()).graph.nodes.length).toBe(2);
    const downstream = (await draft()).graph.nodes.find(
      ({ id }) => id !== triggerId,
    );
    if (downstream === undefined) throw new Error('Downstream step missing');
    await page.getByTestId(`rf__node-${downstream.id}`).focus();
    await page.keyboard.press('Enter');
    await page.getByLabel('Label', { exact: true }).fill('Process feed item');
    await page.keyboard.press('Tab');
    await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
    await mapBrowserInput({
      page,
      field: 'feedItem',
      source: 'Watch feed',
      path: '$.item',
    });
    await expect
      .poll(
        async () =>
          (await draft()).graph.nodes.find(({ id }) => id === downstream.id)
            ?.inputMappings,
      )
      .toHaveProperty('feedItem');

    const version = await publishSingleStep(page, path);
    await page.goto(`${workflowUrl}/triggers`);
    await expect
      .poll(
        async () => {
          const response = await page.request.get(path);
          expect(response.ok()).toBe(true);
          return workflowSummaryResponseSchema
            .parse(await response.json())
            .workflow.pollingTriggers?.find(
              ({ nodeId }) => nodeId === triggerId,
            );
        },
        { timeout: 15_000 },
      )
      .toMatchObject({
        baselineEstablished: true,
        healthStatus: 'healthy',
        lastErrorCode: null,
      });
    const card = page
      .getByRole('region', { name: 'HTTP Polling', exact: true })
      .getByRole('article');
    await expect(card.getByText('Healthy', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      card.getByRole('heading', { name: 'Watch feed' }),
    ).toBeVisible();
    await expect(card.getByText('Next check')).toBeVisible();

    async function runs() {
      const response = await page.request.get(
        `/v1/workspaces/${workspaceId}/runs`,
      );
      expect(response.ok()).toBe(true);
      return workflowRunListResponseSchema.parse(await response.json()).items;
    }

    expect(await runs()).toEqual([]);
    const added = { id: 'new-item', status: 'ready' };
    items.unshift(added);
    const due = new URL('/polling-due', mailOrigin);
    due.search = new URLSearchParams({
      workspaceId,
      workflowId: version.workflowId,
      workflowVersionId: version.id,
    }).toString();
    expect((await request.post(due.href)).status()).toBe(204);
    await expect
      .poll(async () => (await runs()).length, {
        timeout: 15_000,
      })
      .toBe(1);
    const run = (await runs())[0];
    if (run === undefined) throw new Error('The new item did not start a run');
    expect(run.triggerType).toBe('polling');
    const completed = await waitForRun(page, workspaceId, run.id, 'succeeded');
    expect(completed.run.workflowVersionId).toBe(version.id);
    const node = completed.nodes.find(({ nodeId }) => nodeId === downstream.id);
    if (node === undefined) throw new Error('Downstream step did not run');
    const input = await page.request.get(
      `/v1/workspaces/${workspaceId}/runs/${run.id}/node-runs/${node.id}/input`,
    );
    expect(input.ok()).toBe(true);
    expect(
      workflowNodeRunInputResponseSchema.parse(await input.json()).input,
    ).toMatchObject({ kind: 'inline', value: { feedItem: added } });
    await page.goto(`/w/${workspaceId}/runs/${run.id}`);
    await page.getByRole('tab', { name: 'Input & output' }).click();
    await page
      .getByRole('tabpanel', { name: 'Input & output' })
      .getByRole('button', { name: /Process feed item/u })
      .click();
    const dataIn = page.getByRole('group', {
      name: 'Data in of Process feed item',
    });
    await expect(
      dataIn.getByText(`“${added.id}”`, { exact: true }),
    ).toBeVisible();
  } finally {
    await new Promise<void>((resolve, reject) =>
      feed.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
});
