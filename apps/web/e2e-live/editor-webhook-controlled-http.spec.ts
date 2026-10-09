import { expect, type Request } from '@playwright/test';
import {
  nodeDefinitionListResponseSchema,
  connectionResponseSchema,
  webhookDeliveryListResponseSchema,
  webhookTriggerListResponseSchema,
  workflowNodeRunOutputResponseSchema,
} from '@pertexo/contracts';
import { test } from './support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from './support/ordinary-editor-session';
import {
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
  waitForRun,
} from './support/single-step-authoring';
import { authorWebhookHttpGraph } from './support/webhook-http-authoring';
import {
  fillOwnedHttpCredential,
  invokeOwnedWebhook,
} from './support/http-secret-actions';

test('signed acceptance replay produces two immutable runs and one actual controlled HTTP effect', async ({
  page,
  request,
}) => {
  const controlOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (controlOrigin === undefined)
    throw new Error('Run through the owned API fixture');
  await registerEditorUser(
    page,
    request,
    controlOrigin,
    'Controlled HTTP owner',
  );
  const workspaceId = await createEditorWorkspace(
    page,
    'Controlled HTTP workspace',
  );
  // This private control response is transient test material, not VITE configuration.
  const material = await request.get(`${controlOrigin}/http-credential`);
  if (material.status() !== 200)
    throw new Error('Owned credential unavailable');
  const value: unknown = await material.json();
  if (
    typeof value !== 'object' ||
    value === null ||
    !('authorizationValue' in value) ||
    typeof value.authorizationValue !== 'string'
  )
    throw new Error('Owned credential invalid');
  await page.goto(`/w/${workspaceId}/connections`);
  await page
    .getByRole('button', { name: 'Add connection', exact: true })
    .click();
  const chooser = page.getByRole('dialog', {
    name: 'Add a connection',
    exact: true,
  });
  await expect(chooser).toBeVisible();
  await chooser
    .getByRole('button', { name: 'Connect HTTP', exact: true })
    .click();
  const credential = page.getByRole('dialog', {
    name: 'Connect HTTP',
    exact: true,
  });
  await expect(
    credential.getByLabel('Header 1 name', { exact: true }),
  ).toBeVisible();
  await credential
    .getByLabel('Header 1 name', { exact: true })
    .fill('Authorization');
  await fillOwnedHttpCredential(
    credential.getByLabel('Header 1 value', { exact: true }),
    value.authorizationValue,
  );
  await credential
    .getByRole('button', { name: 'Continue', exact: true })
    .click();
  await page
    .getByLabel('Connection name', { exact: true })
    .fill('Owned HTTP credential');
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname ===
        `/v1/workspaces/${workspaceId}/connections`,
  );
  await page
    .getByRole('button', { name: 'Save and test', exact: true })
    .click();
  const savedResponse = await saved;
  if (savedResponse.status() !== 201)
    throw new Error('Owned credential creation failed');
  const connection = connectionResponseSchema.parse(await savedResponse.json());
  await page.getByRole('button', { name: 'Skip test', exact: true }).click();
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Signed HTTP proof',
  );
  const workflowId = workflowPath.split('/').at(-1);
  if (workflowId === undefined) throw new Error('Owned workflow ID missing');
  const catalogResponse = await page.request.get('/v1/node-definitions');
  expect(catalogResponse.status()).toBe(200);
  const catalog = nodeDefinitionListResponseSchema.parse(
    await catalogResponse.json(),
  );
  for (const key of [
    'core.webhook',
    'core.validate',
    'core.set',
    'core.condition',
    'http.request',
  ])
    expect(
      catalog.items.find(
        (item) => item.definition.key === key && item.definition.version === 1,
      ),
    ).toBeDefined();
  const manual: Request[] = [];
  page.on('request', (outgoing) => {
    if (
      outgoing.method() === 'POST' &&
      new URL(outgoing.url()).pathname === `${workflowPath}/runs`
    )
      manual.push(outgoing);
  });
  const authored = await authorWebhookHttpGraph(page, workflowPath);
  await page.reload();
  expect((await readEditorDraft(page, workflowPath)).graph).toEqual(
    authored.graph,
  );
  const publication = page.waitForRequest(
    (outgoing) =>
      outgoing.method() === 'POST' &&
      new URL(outgoing.url()).pathname === `${workflowPath}/publish`,
  );
  const version = await publishSingleStep(page, workflowPath);
  const publishKey = (await publication).headers()['idempotency-key'];
  const triggers = async () => {
    const response = await page.request.get(`${workflowPath}/triggers`);
    expect(response.status()).toBe(200);
    return webhookTriggerListResponseSchema.parse(await response.json());
  };
  await expect.poll(async () => (await triggers()).items.length).toBe(1);
  const trigger = (await triggers()).items[0];
  if (trigger === undefined) throw new Error('Materialized webhook missing');
  expect(trigger).toMatchObject({
    workflowVersionId: version.id,
    nodeId: authored.webhookId,
    endpointReady: false,
  });
  await page.goto(`/w/${workspaceId}/workflows/${workflowId}/triggers`);
  const provision = page.waitForRequest(
    (outgoing) =>
      outgoing.method() === 'POST' &&
      new URL(outgoing.url()).pathname ===
        `${workflowPath}/triggers/${trigger.id}/webhook/provision`,
  );
  await page
    .getByRole('article', { name: 'Webhook: Signed input', exact: true })
    .getByRole('button', { name: 'Create endpoint', exact: true })
    .click();
  const provisionKey = (await provision).headers()['idempotency-key'];
  const reveal = page.getByRole('dialog', {
    name: 'Store these now',
    exact: true,
  });
  await expect(reveal).toBeVisible();
  // Read transient values without assertions/reporters that could dump them.
  const codes = await reveal.locator('code').allTextContents();
  const endpointKey = codes[0],
    signingSecret = codes.at(-1);
  if (
    endpointKey === undefined ||
    signingSecret === undefined ||
    !/^[A-Za-z0-9_-]{43}$/u.test(endpointKey) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(signingSecret)
  )
    throw new Error('Transient webhook credentials missing');
  const scope = {
    workspaceId,
    workflowId,
    workflowVersionId: version.id,
    triggerId: trigger.id,
  };
  const invoked = await invokeOwnedWebhook(request, controlOrigin, {
    ...scope,
    endpointKey,
    signingSecret,
  });
  if (invoked.status() !== 200)
    throw new Error('Owned signed invocation failed');
  const receipt: unknown = await invoked.json();
  if (
    typeof receipt !== 'object' ||
    receipt === null ||
    !('trueRunId' in receipt) ||
    typeof receipt.trueRunId !== 'string' ||
    !('falseRunId' in receipt) ||
    typeof receipt.falseRunId !== 'string' ||
    !('senderKey' in receipt) ||
    typeof receipt.senderKey !== 'string' ||
    !('falseKey' in receipt) ||
    typeof receipt.falseKey !== 'string'
  )
    throw new Error('Owned invocation receipt invalid');
  await reveal
    .getByRole('switch', { name: 'I’ve stored these', exact: true })
    .click();
  await reveal.getByRole('button', { name: 'Done', exact: true }).click();
  const trueRun = await waitForRun(
    page,
    workspaceId,
    receipt.trueRunId,
    'succeeded',
  );
  const falseRun = await waitForRun(
    page,
    workspaceId,
    receipt.falseRunId,
    'succeeded',
  );
  for (const run of [trueRun, falseRun])
    expect(run.run.workflowVersionId).toBe(version.id);
  const http = trueRun.nodes.find((node) => node.nodeId === authored.httpId);
  if (http === undefined) throw new Error('Completed action missing');
  expect(http.status).toBe('succeeded');
  const output = await page.request.get(
    `/v1/workspaces/${workspaceId}/runs/${receipt.trueRunId}/node-runs/${http.id}/output`,
  );
  expect(output.status()).toBe(200);
  const payload = workflowNodeRunOutputResponseSchema.parse(
    await output.json(),
  );
  expect(payload.output).toMatchObject({
    kind: 'inline',
    value: {
      status: 200,
      body: {
        kind: 'inline',
        encoding: 'utf8',
        value: JSON.stringify({
          accepted: true,
          body: { marker: 'browser-mapped', amount: 7 },
        }),
      },
    },
  });
  expect(
    falseRun.nodes.find((node) => node.nodeId === authored.httpId)?.status,
  ).toBe('skipped');
  const deliveries = await page.request.get(
    `${workflowPath}/triggers/${trigger.id}/webhook/deliveries`,
  );
  expect(deliveries.status()).toBe(200);
  expect(
    webhookDeliveryListResponseSchema
      .parse(await deliveries.json())
      .items.map(({ outcome }) => outcome)
      .sort(),
  ).toEqual(['accepted', 'accepted', 'conflict', 'replayed']);
  for (const id of [receipt.trueRunId, receipt.falseRunId]) {
    await page.goto(`/w/${workspaceId}/runs/${id}`);
    await expect(
      page.getByRole('link', { name: 'v1', exact: true }),
    ).toHaveAttribute(
      'href',
      `/w/${workspaceId}/workflows/${workflowId}/versions`,
    );
  }
  expect(manual).toHaveLength(0);
  const evidence = await request.post(`${controlOrigin}/evidence/http`, {
    data: {
      ...scope,
      connectionId: connection.id,
      trueRunId: receipt.trueRunId,
      falseRunId: receipt.falseRunId,
      senderKey: receipt.senderKey,
      falseKey: receipt.falseKey,
      publishKey,
      provisionKey,
      webhookId: authored.webhookId,
      validateId: authored.validateId,
      mapId: authored.mapId,
      conditionId: authored.conditionId,
      httpId: authored.httpId,
    },
  });
  expect(evidence.status()).toBe(204);
});
