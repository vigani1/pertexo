import {
  workflowRunResponseSchema,
  workflowRunStartResponseSchema,
} from '@pertexo/contracts';

import { expect } from '@playwright/test';

import { randomUUID } from 'node:crypto';

import { csrfHeaders } from '../../../test/support/browser/csrf';

import {
  addSingleStep,
  createEditorWorkflow,
  readEditorDraft,
  waitForRun,
} from '../../support/authoring/single-step';

import { test } from '../../support/browser-fixture';

import {
  createEditorWorkspace,
  registerEditorUser,
} from '../../support/ordinary-editor-session';

import { publishGraph, saveGraph } from './fixture';

test('pins and upgrades a callable child, renders linked history, and warns before archive', async ({
  page,
  request,
}, info) => {
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined)
    throw new Error('Use the owned callable API browser fixture');
  await registerEditorUser(page, request, mailOrigin, 'Call owner');
  const workspaceId = await createEditorWorkspace(
    page,
    'Workflow Call qualification',
  );
  const childPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Customer child',
  );
  await addSingleStep(page, childPath, /Manual/u, 'Customer input');
  const childDraft = await readEditorDraft(page, childPath);
  const declaration = {
    input: {
      type: 'object',
      properties: [
        { name: 'customer', valueType: { type: 'string' }, required: true },
      ],
    },
    resultType: { type: 'string' },
    result: { kind: 'run_input', path: '$.customer' },
  };
  await saveGraph(page, childPath, {
    ...childDraft.graph,
    callable: declaration,
  });
  const childVersion = await publishGraph(page, childPath);
  const parentPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Customer parent',
  );
  const callId = await addSingleStep(
    page,
    parentPath,
    /Call workflow/u,
    'Call customer',
  );
  await page
    .getByRole('combobox', { name: 'Child workflow', exact: true })
    .click();
  await page
    .getByRole('option', { name: 'Customer child', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: 'Published version', exact: true })
    .click();
  await page.getByRole('option', { name: 'Version 1', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, parentPath)).graph.nodes[0]?.config.target,
    )
    .toEqual({
      workflowId: childVersion.workflowId,
      workflowVersionId: childVersion.id,
      executableChecksum: childVersion.checksum,
    });
  const parentDraft = await readEditorDraft(page, parentPath);
  const callNode = parentDraft.graph.nodes[0];
  if (callNode === undefined) throw new Error('Call step missing');
  const manual = {
    ...childDraft.graph.nodes[0],
    id: 'parent-input',
    position: { x: 0, y: 0 },
    label: 'Parent input',
  };
  await saveGraph(page, parentPath, {
    ...parentDraft.graph,
    nodes: [
      manual,
      {
        ...callNode,
        position: { x: 300, y: 0 },
        inputMappings: {
          input: { kind: 'literal', value: { customer: 'Ada' } },
        },
      },
    ],
    edges: [
      {
        id: 'enter-call',
        source: { nodeId: 'parent-input', port: 'out' },
        target: { nodeId: callId, port: 'in' },
      },
    ],
  });
  const parentVersion = await publishGraph(page, parentPath);
  async function start(status: 'succeeded' | 'failed') {
    const response = await page.request.post(`${parentPath}/runs`, {
      headers: {
        ...(await csrfHeaders(page)),
        'Idempotency-Key': randomUUID(),
      },
      data: { input: { customer: 'Ada' } },
    });
    expect(response.status()).toBe(202);
    const run = workflowRunStartResponseSchema.parse(await response.json()).run;
    await waitForRun(page, workspaceId, run.id, status);
    const read = await page.request.get(
      `/v1/workspaces/${workspaceId}/runs/${run.id}`,
    );
    return workflowRunResponseSchema.parse(await read.json());
  }
  const first = await start('succeeded');
  expect(first.calls?.[0]?.targetVersionId).toBe(childVersion.id);
  await saveGraph(page, childPath, {
    ...childDraft.graph,
    callable: {
      ...declaration,
      result: {
        kind: 'expression',
        language: 'jsonata',
        expression: 'runInput.customer & "!"',
      },
    },
  });
  const upgraded = await publishGraph(page, childPath);
  await page.goto(`/w/${workspaceId}/workflows/${parentVersion.workflowId}`);
  await page.getByTestId(`rf__node-${callId}`).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('combobox', { name: 'Published version', exact: true }),
  ).toContainText('Version 1');
  await page
    .getByRole('button', { name: 'Upgrade to version 2', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, parentPath)).graph.nodes.find(
          (node) => node.id === callId,
        )?.config.target,
    )
    .toEqual({
      workflowId: upgraded.workflowId,
      workflowVersionId: upgraded.id,
      executableChecksum: upgraded.checksum,
    });
  await page
    .getByRole('complementary', { name: 'Step panel' })
    .screenshot({ path: info.outputPath('call-picker-desktop.png') });
  await publishGraph(page, parentPath);
  const second = await start('succeeded');
  await page.goto(`/w/${workspaceId}/runs/${second.run.id}`);
  await page.getByRole('link', { name: 'Open child run', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Open parent run', exact: true }),
  ).toHaveAttribute('href', `/w/${workspaceId}/runs/${second.run.id}`);
  await page.goto(`/w/${workspaceId}/workflows`);
  await page
    .getByRole('button', { name: 'Actions for Customer child', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Archive…', exact: true }).click();
  const archive = page.getByRole('dialog', {
    name: 'Archive this workflow?',
    exact: true,
  });
  await expect(
    archive.getByText('Customer parent', { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    archive.getByRole('button', { name: 'Archive', exact: true }),
  ).toBeInViewport();
  await archive.screenshot({
    path: info.outputPath('call-archive-mobile.png'),
  });
  await archive.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(archive).toBeHidden();
  const refused = await start('failed');
  expect(refused.calls?.[0]).toMatchObject({
    status: 'refused',
    childRunId: null,
    safeErrorCode: 'call_target_unavailable',
  });
  const evidence = await request.post(`${mailOrigin}/evidence/calls`, {
    data: {
      workspaceId,
      parentWorkflowId: parentVersion.workflowId,
      childWorkflowId: childVersion.workflowId,
      firstRunId: first.run.id,
      secondRunId: second.run.id,
      refusedRunId: refused.run.id,
    },
  });
  expect(evidence.status()).toBe(204);
});
