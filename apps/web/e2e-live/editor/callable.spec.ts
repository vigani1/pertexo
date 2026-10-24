import { csrfHeaders } from '../../test/support/browser/csrf';
import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import {
  apiProblemSchema,
  workflowPublishResponseSchema,
  workflowRunStartResponseSchema,
  workflowValidateResponseSchema,
  workflowRunResponseSchema,
} from '@pertexo/contracts';
import { test } from '../support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from '../support/ordinary-editor-session';
import {
  addSingleStep,
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
  waitForRun,
} from '../support/authoring/single-step';

test('authors a callable contract with keyboard controls and validates standalone HTTP input/results', async ({
  page,
  request,
}, info) => {
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined)
    throw new Error('Use the owned callable API browser fixture');
  await registerEditorUser(page, request, mailOrigin, 'Callable owner');
  const workspaceId = await createEditorWorkspace(
    page,
    'Callable qualification',
  );
  const path = await createEditorWorkflow(
    page,
    workspaceId,
    'Customer contract',
  );
  await addSingleStep(page, path, /Manual/u, 'Customer input');
  const contract = page.getByRole('button', {
    name: 'Workflow contract',
    exact: true,
  });
  await contract.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', {
    name: 'Workflow contract',
    exact: true,
  });
  await dialog
    .getByRole('checkbox', { name: 'Declare a callable contract' })
    .focus();
  await page.keyboard.press('Space');
  const input = dialog.getByRole('group', { name: 'Accepted input' });
  await input.getByRole('button', { name: 'Add property' }).click();
  await input.getByLabel('Property name', { exact: true }).fill('customer');
  await dialog
    .getByRole('group', { name: 'Returned value' })
    .getByLabel('Value type', { exact: true })
    .click();
  await page.getByRole('option', { name: 'String', exact: true }).click();
  await dialog.getByLabel('Result path', { exact: true }).fill('$.customer');
  await expect(
    dialog.getByRole('heading', { name: 'Workflow contract', exact: true }),
  ).toBeInViewport();
  await expect(
    dialog.getByRole('button', { name: 'Apply contract', exact: true }),
  ).toBeInViewport();
  await dialog.screenshot({ path: info.outputPath('callable-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('heading', { name: 'Workflow contract', exact: true }),
  ).toBeInViewport();
  await expect(
    dialog.getByRole('button', { name: 'Apply contract', exact: true }),
  ).toBeInViewport();
  const bounds = await dialog.boundingBox();
  expect(bounds?.width).toBeLessThanOrEqual(390);
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await dialog.screenshot({ path: info.outputPath('callable-mobile.png') });
  await dialog.getByRole('button', { name: 'Apply contract' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  const more = page.getByRole('button', {
    name: 'More workflow actions',
    exact: true,
  });
  await expect(more).toBeFocused();
  await more.press('Enter');
  await page
    .getByRole('menuitem', { name: 'Workflow contract', exact: true })
    .press('Enter');
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('button', { name: 'Cancel', exact: true })
    .press('Enter');
  await expect(dialog).toBeHidden();
  await expect(more).toBeFocused();
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, path)).graph.callable?.resultType.type,
    )
    .toBe('string');
  await page.setViewportSize({ width: 1280, height: 900 });
  const published = await publishSingleStep(page, path);
  const headers = await csrfHeaders(page);
  for (const inputValue of [
    undefined,
    { customer: 7 },
    { customer: 'Ada', extra: true },
  ]) {
    const refused = await page.request.post(`${path}/runs`, {
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      data: {
        expectedPublishedVersionId: published.id,
        ...(inputValue === undefined ? {} : { input: inputValue }),
      },
    });
    expect(refused.status()).toBe(400);
    expect(apiProblemSchema.parse(await refused.json()).code).toBe(
      'request.invalid',
    );
  }
  const key = randomUUID();
  const startRequest = {
    headers: { ...headers, 'Idempotency-Key': key },
    data: {
      input: { customer: 'Ada' },
      expectedPublishedVersionId: published.id,
    },
  };
  const accepted = await page.request.post(`${path}/runs`, startRequest);
  expect(accepted.status()).toBe(202);
  const first = workflowRunStartResponseSchema.parse(await accepted.json()).run;
  await waitForRun(page, workspaceId, first.id, 'succeeded');
  const replay = await page.request.post(`${path}/runs`, startRequest);
  expect(replay.status()).toBe(202);
  expect(workflowRunStartResponseSchema.parse(await replay.json()).run.id).toBe(
    first.id,
  );
  const draftResponse = await page.request.get(`${path}/draft`);
  expect(draftResponse.status()).toBe(200);
  const draft = await readEditorDraft(page, path);
  if (draft.graph.callable === undefined)
    throw new Error('Saved callable declaration missing');
  const saved = await page.request.put(`${path}/draft`, {
    headers: { ...headers, 'If-Match': draftResponse.headers().etag ?? '' },
    data: {
      graph: {
        ...draft.graph,
        callable: {
          ...draft.graph.callable,
          result: { kind: 'run_input', path: '$.missing' },
        },
      },
    },
  });
  expect(saved.status()).toBe(200);
  const checked = await page.request.post(`${path}/validate`, {
    headers,
    data: {},
  });
  expect(checked.status()).toBe(200);
  expect(workflowValidateResponseSchema.parse(await checked.json()).valid).toBe(
    true,
  );
  const publishedFailure = await page.request.post(`${path}/publish`, {
    headers: {
      ...headers,
      'If-Match': checked.headers().etag ?? '',
      'Idempotency-Key': randomUUID(),
    },
    data: {},
  });
  expect(publishedFailure.status()).toBe(200);
  const failedVersion = workflowPublishResponseSchema.parse(
    await publishedFailure.json(),
  ).version.id;
  const secondResponse = await page.request.post(`${path}/runs`, {
    headers: { ...headers, 'Idempotency-Key': randomUUID() },
    data: {
      input: { customer: 'Ada' },
      expectedPublishedVersionId: failedVersion,
    },
  });
  expect(secondResponse.status()).toBe(202);
  const second = workflowRunStartResponseSchema.parse(
    await secondResponse.json(),
  ).run;
  await waitForRun(page, workspaceId, second.id, 'failed');
  const evidence = await request.post(`${mailOrigin}/evidence/callable`, {
    data: {
      workspaceId,
      workflowId: first.workflowId,
      successRunId: first.id,
      failedRunId: second.id,
      successVersionId: published.id,
      failedVersionId: failedVersion,
    },
  });
  expect(evidence.status()).toBe(204);
});

async function saveGraph(page: Page, path: string, graph: unknown) {
  const response = await page.request.get(`${path}/draft`);
  const saved = await page.request.put(`${path}/draft`, {
    headers: {
      ...(await csrfHeaders(page)),
      'If-Match': response.headers().etag ?? '',
    },
    data: { graph },
  });
  expect(saved.status()).toBe(200);
}
async function publishGraph(page: Page, path: string) {
  const checked = await page.request.post(`${path}/validate`, {
    headers: await csrfHeaders(page),
    data: {},
  });
  expect(checked.status()).toBe(200);
  expect(workflowValidateResponseSchema.parse(await checked.json()).valid).toBe(
    true,
  );
  const published = await page.request.post(`${path}/publish`, {
    headers: {
      ...(await csrfHeaders(page)),
      'If-Match': checked.headers().etag ?? '',
      'Idempotency-Key': randomUUID(),
    },
    data: {},
  });
  expect(published.status()).toBe(200);
  return workflowPublishResponseSchema.parse(await published.json()).version;
}

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
