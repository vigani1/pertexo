import { expect } from '@playwright/test';
import { test } from '../support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from '../support/ordinary-editor-session';
import { authorNestedMappingGraph } from '../support/authoring/nested';
import { verifyEditorConflictAndImmutableRun } from '../support/editor-conflict-recovery';
import { verifyEditorWorkspaceIsolation } from '../support/editor-workspace-isolation';
import {
  workflowDraftResponseSchema,
  workflowVersionsResponseSchema,
  workflowNodeRunInputResponseSchema,
  workflowNodeRunOutputResponseSchema,
  workflowRunResponseSchema,
} from '@pertexo/contracts';

test('real nested execution, two-context conflict, immutable version and workspace isolation', async ({
  browser,
  page,
  request,
}) => {
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined)
    throw new Error('Run through the owned API integration fixture');
  const email = await registerEditorUser(
    page,
    request,
    mailOrigin,
    'Live editor owner',
  );
  const workspaceId = await createEditorWorkspace(
    page,
    'Live editor qualification',
  );
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('link', { name: 'Workflows', exact: true })
    .click();
  await expect(page).toHaveURL(`/w/${workspaceId}/workflows`);
  await page.getByRole('button', { name: 'New workflow', exact: true }).click();
  await page
    .getByLabel('Workflow name', { exact: true })
    .fill('Pure core browser execution');
  await page
    .getByRole('button', { name: 'Create workflow', exact: true })
    .click();
  await expect(page).toHaveURL(/\/workflows\/[^/]+$/u);
  const workflowId = new URL(page.url()).pathname.split('/')[4];
  if (workflowId === undefined)
    throw new Error('Workflow URL has no identifier');
  const summaryResponse = await page.request.get(
    `/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
  );
  expect(
    summaryResponse.status(),
    JSON.stringify(await summaryResponse.json()),
  ).toBe(200);
  const draftResponse = await page.request.get(
    `/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
  );
  expect(
    draftResponse.status(),
    JSON.stringify(await draftResponse.json()),
  ).toBe(200);
  await expect(
    page.getByRole('complementary', { name: 'Add a step' }),
  ).toBeVisible();
  const authored = await authorNestedMappingGraph(
    page,
    `/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
  );
  await expect(
    page.getByRole('button', { name: 'Publish v1', exact: true }),
  ).toBeEnabled();
  await page.reload();
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  const reloaded = await page.request.get(
    `/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
  );
  expect(reloaded.status()).toBe(200);
  expect(
    workflowDraftResponseSchema.parse(await reloaded.json()).graph,
  ).toEqual(authored.graph);
  await page.getByRole('button', { name: 'Publish v1', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Publish v1' })
    .getByRole('button', { name: 'Publish v1', exact: true })
    .click();
  await expect(page.getByText('v1 is live', { exact: true })).toBeVisible();
  const versionsResponse = await page.request.get(
    `/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions`,
  );
  expect(versionsResponse.status()).toBe(200);
  const versions = workflowVersionsResponseSchema.parse(
    await versionsResponse.json(),
  );
  expect(versions.items).toHaveLength(1);
  const version = versions.items[0];
  if (version === undefined)
    throw new Error('Published immutable version missing');
  expect(version.graph).toEqual(authored.graph);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Run with input…', exact: true })
    .click();
  const input = {
    amount: 6000,
    groups: [
      ['north-0', 'north-1'],
      ['south-0', 'south-1'],
    ],
  };
  await page
    .getByLabel('Run input (JSON)', { exact: true })
    .fill(JSON.stringify(input));
  await page
    .getByRole('button', { name: 'Start published version', exact: true })
    .click();
  await expect(page).toHaveURL(/\/runs\/[^/]+/u);
  const runId = new URL(page.url()).pathname.split('/')[4];
  if (runId === undefined) throw new Error('Run URL has no identifier');
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/v1/workspaces/${workspaceId}/runs/${runId}`,
        );
        expect(response.ok()).toBe(true);
        const body = workflowRunResponseSchema.parse(await response.json());
        return body.run.status;
      },
      { timeout: 20_000 },
    )
    .toBe('succeeded');
  const acceptedRun = workflowRunResponseSchema.parse(
    await (
      await page.request.get(`/v1/workspaces/${workspaceId}/runs/${runId}`)
    ).json(),
  );
  expect(acceptedRun.run.workflowVersionId).toBe(version.id);
  expect(acceptedRun.nodes).toHaveLength(8);
  expect(acceptedRun.nodes.every((node) => node.status === 'succeeded')).toBe(
    true,
  );
  const nodeRun = acceptedRun.nodes.find(
    (node) => node.nodeId === authored.rootId,
  );
  if (nodeRun === undefined)
    throw new Error('Accepted run has no root step execution');
  const nodeOutput = await page.request.get(
    `/v1/workspaces/${workspaceId}/runs/${runId}/node-runs/${nodeRun.id}/output`,
  );
  expect(nodeOutput.status()).toBe(200);
  expect(
    workflowNodeRunOutputResponseSchema.parse(await nodeOutput.json()).output,
  ).toEqual({
    kind: 'inline',
    value: {
      literalProof: 'from-real-browser',
      matrix: input.groups,
      expressionProof: true,
    },
  });
  const leaves = acceptedRun.nodes.filter(
    (node) => node.nodeId === authored.leafId,
  );
  expect(leaves).toHaveLength(4);
  expect(new Set(leaves.map((node) => node.invocationKey)).size).toBe(4);
  expect(
    acceptedRun.nodes.filter((node) => node.nodeId === authored.innerId),
  ).toHaveLength(2);
  const outputs = [];
  for (const leaf of leaves) {
    const path = `/v1/workspaces/${workspaceId}/runs/${runId}/node-runs/${leaf.id}`;
    const outputResponse = await page.request.get(`${path}/output`);
    const inputResponse = await page.request.get(`${path}/input`);
    expect(outputResponse.status()).toBe(200);
    expect(inputResponse.status()).toBe(200);
    const output = workflowNodeRunOutputResponseSchema.parse(
      await outputResponse.json(),
    ).output;
    expect(
      workflowNodeRunInputResponseSchema.parse(await inputResponse.json())
        .input,
    ).toEqual(output);
    outputs.push(output);
  }
  expect(outputs).toEqual(
    expect.arrayContaining(
      input.groups.flatMap((group) =>
        group.map((item, ordinal) => ({
          kind: 'inline',
          value: { item, ordinal },
        })),
      ),
    ),
  );
  const recovery = await verifyEditorConflictAndImmutableRun(browser, page, {
    email,
    workspaceId,
    workflowId,
    rootId: authored.rootId,
    runId,
    version,
  });
  const outsiderWorkspaceId = await verifyEditorWorkspaceIsolation(
    browser,
    request,
    {
      origin: new URL(page.url()).origin,
      mailOrigin,
      workspaceId,
      workflowId,
      runId,
    },
  );
  const response = await request.post(`${mailOrigin}/evidence`, {
    data: {
      workspaceId,
      workflowId,
      runId,
      workflowVersionId: version.id,
      rootId: authored.rootId,
      outerId: authored.outerId,
      innerId: authored.innerId,
      leafId: authored.leafId,
      ...recovery,
      outsiderWorkspaceId,
    },
  });
  expect(response.status()).toBe(204);
});
