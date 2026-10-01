import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { nodeDefinitionListResponseSchema } from '@pertexo/contracts/schemas/catalog';
import {
  workflowDraftResponseSchema,
  workflowCreateResponseSchema,
  workflowDuplicateResponseSchema,
  workflowPublishResponseSchema,
  workflowValidateResponseSchema,
  type WorkflowGraphContract,
} from '@pertexo/contracts/schemas/workflow-authoring';
import {
  workflowRunStartResponseSchema,
  workflowNodeRunOutputResponseSchema,
} from '@pertexo/contracts/schemas/workflow-runs';
import { test } from './support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from './support/ordinary-editor-session';
import { readTaggedExpressionDraft } from './support/expression-editor-authoring';
import { waitForRun } from './support/single-step-authoring';

async function csrf(page: Page) {
  const cookie = (await page.context().cookies()).find(
    (item) => item.name === 'pertexo_csrf',
  );
  if (cookie === undefined)
    throw new Error('Ordinary authenticated CSRF cookie missing');
  return { 'x-csrf-token': decodeURIComponent(cookie.value) };
}

/** Real authenticated authoring API setup; no database graph/cookie seeding. */
async function sourceGraph(page: Page) {
  const response = await page.request.get('/v1/node-definitions');
  expect(response.status()).toBe(200);
  const catalog = nodeDefinitionListResponseSchema.parse(await response.json());
  function node(
    key: string,
    x: number,
  ): WorkflowGraphContract['nodes'][number] {
    const entry = catalog.items
      .filter(
        (item) =>
          item.definition.key === key && item.available && item.publishable,
      )
      .sort((a, b) => b.definition.version - a.definition.version)[0];
    if (entry === undefined) throw new Error(`Live catalog missing ${key}`);
    return {
      id: randomUUID(),
      definition: entry.definition,
      configVersion: entry.configVersion,
      config: {},
      inputMappings: {},
      connectionRefs: {},
      position: { x, y: 0 },
      label: key,
    };
  }
  const producer = {
    ...node('core.set', 0),
    inputMappings: { value: { kind: 'run_input' as const, path: '$.value' } },
  };
  const dynamic = {
    ...node('core.set', 260),
    inputMappings: {
      value: {
        kind: 'expression' as const,
        language: 'jsonata' as const,
        policyVersion: 1,
        expression: '$lookup(nodeOutputs, runInput.stepId).value',
      },
    },
  };
  const parallel = {
    ...node('core.parallel', 0),
    config: {
      branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
      maxConcurrency: 2,
    },
  };
  const left = {
    ...node('core.set', 260),
    inputMappings: {
      item: { kind: 'structured_input' as const, port: 'item', path: '$' },
    },
  };
  const right = {
    ...node('core.set', 260),
    position: { x: 260, y: 160 },
    inputMappings: {
      item: { kind: 'structured_input' as const, port: 'item', path: '$' },
    },
  };
  const merge = {
    ...node('core.merge', 520),
    config: { parallelNodeId: parallel.id, policy: { kind: 'all' } },
  };
  function edge(from: string, to: string, out = 'out', into = 'in') {
    return {
      id: randomUUID(),
      source: { nodeId: from, port: out },
      target: { nodeId: to, port: into },
    };
  }
  const loop = {
    ...node('core.foreach', 520),
    inputMappings: {
      items: { kind: 'literal' as const, value: ['first', 'second'] },
    },
    structured: {
      kind: 'for_each' as const,
      maxIterations: 2,
      maxConcurrency: 1,
      body: {
        schemaVersion: 1 as const,
        nodes: [parallel, left, right, merge],
        edges: [
          edge(parallel.id, left.id, 'branch-01'),
          edge(parallel.id, right.id, 'branch-02'),
          edge(left.id, merge.id, 'out', 'branch-01'),
          edge(right.id, merge.id, 'out', 'branch-02'),
        ],
        settings: {},
        inputPorts: ['item', 'ordinal'],
        outputPorts: ['result'],
      },
    },
  };
  return {
    graph: {
      schemaVersion: 1 as const,
      nodes: [producer, dynamic, loop],
      edges: [edge(producer.id, dynamic.id), edge(dynamic.id, loop.id)],
      settings: { maxRunDurationMs: 60_000 },
    },
    producerId: producer.id,
    dynamicNodeId: dynamic.id,
  };
}

async function publish(page: Page, path: string) {
  const checked = await page.request.post(`${path}/validate`, {
    headers: await csrf(page),
    data: {},
  });
  expect(checked.status()).toBe(200);
  const report = workflowValidateResponseSchema.parse(await checked.json());
  expect(report.issues).toEqual([]);
  expect(report.valid).toBe(true);
  const tag = checked.headers().etag;
  if (tag === undefined) throw new Error('Checked source tag missing');
  const response = await page.request.post(`${path}/publish`, {
    headers: {
      ...(await csrf(page)),
      'If-Match': tag,
      'Idempotency-Key': randomUUID(),
    },
    data: {},
  });
  const body: unknown = await response.json();
  expect(
    response.status(),
    response.ok() ? 'Published version' : JSON.stringify(body),
  ).toBe(200);
  return workflowPublishResponseSchema.parse(body).version.id;
}

test('real same-workspace draft and selected-version copies preserve graph IDs and isolate execution', async ({
  page,
  request,
}) => {
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined)
    throw new Error('Run through the owned API integration fixture');
  await registerEditorUser(
    page,
    request,
    mailOrigin,
    'Workflow duplication owner',
  );
  const workspaceId = await createEditorWorkspace(
    page,
    'Workflow duplication qualification',
  );
  const root = `/v1/workspaces/${workspaceId}/workflows`;
  const created = await page.request.post(root, {
    headers: { ...(await csrf(page)), 'Idempotency-Key': randomUUID() },
    data: { name: 'Shared graph source' },
  });
  expect(created.status()).toBe(201);
  const sourceWorkflowId = workflowCreateResponseSchema.parse(
    await created.json(),
  ).workflow.id;
  const sourcePath = `${root}/${sourceWorkflowId}`;
  const baseline = await readTaggedExpressionDraft(page, sourcePath);
  const authored = await sourceGraph(page);
  const saved = await page.request.put(`${sourcePath}/draft`, {
    headers: { ...(await csrf(page)), 'If-Match': baseline.etag },
    data: { graph: authored.graph },
  });
  expect(saved.status()).toBe(200);
  expect(workflowDraftResponseSchema.parse(await saved.json()).graph).toEqual(
    authored.graph,
  );
  const sourceVersionId = await publish(page, sourcePath);

  await page.goto(`/w/${workspaceId}/workflows`);
  await page
    .getByRole('button', { name: 'Actions for Shared graph source' })
    .click();
  await page
    .getByRole('menuitem', { name: 'Duplicate workflow…', exact: true })
    .click();
  const draftDialog = page.getByRole('dialog', {
    name: 'Duplicate workflow',
    exact: true,
  });
  await expect(
    draftDialog.getByText(/Source: saved draft revision/u),
  ).toBeVisible();
  await draftDialog.getByLabel('Copy name').fill('Saved draft copy');
  const draftPending = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${sourcePath}/duplicate` &&
      response.request().method() === 'POST',
  );
  await draftDialog
    .getByRole('button', { name: 'Duplicate workflow', exact: true })
    .click();
  const draftResponse = await draftPending;
  expect(draftResponse.status()).toBe(201);
  const draftCopyId = workflowDuplicateResponseSchema.parse(
    await draftResponse.json(),
  ).workflowId;
  expect(draftCopyId).not.toBe(sourceWorkflowId);
  await expect(page).toHaveURL(`/w/${workspaceId}/workflows/${draftCopyId}`);
  const draftCopy = await readTaggedExpressionDraft(
    page,
    `${root}/${draftCopyId}`,
  );
  expect(draftCopy.draft.revision).toBe(1);
  expect(draftCopy.draft.graph).toEqual(authored.graph);

  await page.goto(`/w/${workspaceId}/workflows/${sourceWorkflowId}/versions`);
  await page.getByRole('button', { name: 'Duplicate v1', exact: true }).click();
  const versionDialog = page.getByRole('dialog', {
    name: 'Duplicate workflow',
    exact: true,
  });
  await expect(
    versionDialog.getByText(/Source: immutable version v1/u),
  ).toBeVisible();
  await versionDialog.getByLabel('Copy name').fill('Selected version copy');
  const versionPending = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${sourcePath}/duplicate` &&
      response.request().method() === 'POST',
  );
  await versionDialog
    .getByRole('button', { name: 'Duplicate workflow', exact: true })
    .click();
  const versionResponse = await versionPending;
  expect(versionResponse.status()).toBe(201);
  const versionCopyId = workflowDuplicateResponseSchema.parse(
    await versionResponse.json(),
  ).workflowId;
  expect(new Set([sourceWorkflowId, draftCopyId, versionCopyId]).size).toBe(3);
  await expect(page).toHaveURL(`/w/${workspaceId}/workflows/${versionCopyId}`);
  const versionCopy = await readTaggedExpressionDraft(
    page,
    `${root}/${versionCopyId}`,
  );
  expect(versionCopy.draft.revision).toBe(1);
  expect(versionCopy.draft.graph).toEqual(authored.graph);
  const draftCopyVersionId = await publish(page, `${root}/${draftCopyId}`);
  const versionCopyVersionId = await publish(page, `${root}/${versionCopyId}`);
  expect(
    new Set([sourceVersionId, draftCopyVersionId, versionCopyVersionId]).size,
  ).toBe(3);

  const runIds: string[] = [];
  for (const [workflowId, versionId, marker] of [
    [sourceWorkflowId, sourceVersionId, 'source-marker'],
    [draftCopyId, draftCopyVersionId, 'draft-copy-marker'],
    [versionCopyId, versionCopyVersionId, 'version-copy-marker'],
  ]) {
    if (
      workflowId === undefined ||
      versionId === undefined ||
      marker === undefined
    )
      throw new Error('Run proof tuple missing');
    const started = await page.request.post(`${root}/${workflowId}/runs`, {
      headers: { ...(await csrf(page)), 'Idempotency-Key': randomUUID() },
      data: {
        input: { value: marker, stepId: authored.producerId },
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(started.status()).toBe(202);
    const run = workflowRunStartResponseSchema.parse(await started.json()).run;
    runIds.push(run.id);
    expect(run.workflowVersionId).toBe(versionId);
    const completed = await waitForRun(page, workspaceId, run.id, 'succeeded');
    const dynamic = completed.nodes.find(
      (node) => node.nodeId === authored.dynamicNodeId,
    );
    if (dynamic === undefined)
      throw new Error('Dynamic lookup invocation missing');
    const output = await page.request.get(
      `/v1/workspaces/${workspaceId}/runs/${run.id}/node-runs/${dynamic.id}/output`,
    );
    expect(output.status()).toBe(200);
    expect(
      workflowNodeRunOutputResponseSchema.parse(await output.json()).output,
    ).toEqual({ kind: 'inline', value: { value: marker } });
  }
  const firstCopy = await readTaggedExpressionDraft(
    page,
    `${root}/${draftCopyId}`,
  );
  const changedGraph = {
    ...firstCopy.draft.graph,
    nodes: firstCopy.draft.graph.nodes.map((node) =>
      node.id === authored.dynamicNodeId
        ? { ...node, label: 'Independent copy edit' }
        : node,
    ),
  };
  const edited = await page.request.put(`${root}/${draftCopyId}/draft`, {
    headers: { ...(await csrf(page)), 'If-Match': firstCopy.etag },
    data: { graph: changedGraph },
  });
  expect(edited.status()).toBe(200);
  expect(
    (await readTaggedExpressionDraft(page, sourcePath)).draft.graph,
  ).toEqual(authored.graph);
  expect(
    (await readTaggedExpressionDraft(page, `${root}/${versionCopyId}`)).draft
      .graph,
  ).toEqual(authored.graph);
  expect(
    (await readTaggedExpressionDraft(page, `${root}/${draftCopyId}`)).draft
      .graph,
  ).toEqual(changedGraph);
  const evidence = await request.post(`${mailOrigin}/evidence/duplication`, {
    data: {
      workspaceId,
      sourceWorkflowId,
      draftCopyId,
      versionCopyId,
      sourceVersionId,
      draftCopyVersionId,
      versionCopyVersionId,
      sourceRunId: runIds[0],
      draftCopyRunId: runIds[1],
      versionCopyRunId: runIds[2],
      dynamicNodeId: authored.dynamicNodeId,
    },
  });
  expect(evidence.status()).toBe(204);
});
