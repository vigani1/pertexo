import './coordination/events.case';
import { createHmac, randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { test } from '../support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
} from '../support/ordinary-editor-session';
import {
  createEditorWorkflow,
  readEditorDraft,
  publishSingleStep,
  startSingleStep,
  waitForRun,
} from '../support/authoring/single-step';
import {
  workflowRunListResponseSchema,
  webhookTriggerListResponseSchema,
} from '@pertexo/contracts';

async function add(page: Page, path: string, kind: RegExp, label: string) {
  const before = (await readEditorDraft(page, path)).graph.nodes;
  await page
    .getByRole('complementary', { name: 'Add a step' })
    .getByRole('button', { name: kind })
    .click();
  await expect
    .poll(async () => (await readEditorDraft(page, path)).graph.nodes.length)
    .toBe(before.length + 1);
  const node = (await readEditorDraft(page, path)).graph.nodes.find(
    (n) => !before.some((old) => old.id === n.id),
  );
  if (node === undefined) throw new Error('Authored response step missing');
  await page.getByTestId(`rf__node-${node.id}`).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Label', { exact: true }).fill(label);
  await page.keyboard.press('Tab');
  return node.id;
}
async function literal(
  page: Page,
  field: string,
  value: unknown,
  number = false,
) {
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  const row = page
    .getByRole('region', { name: 'Inputs', exact: true })
    .locator('ol > li')
    .last();
  await row.getByLabel('Field', { exact: true }).fill(field);
  await row
    .getByLabel(number ? 'Value' : 'JSON value', { exact: true })
    .fill(JSON.stringify(value));
  await page.keyboard.press('Tab');
}
async function signed(
  origin: string,
  endpointKey: string,
  secret: string,
  key: string,
) {
  const body = '{}';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v1=${createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(timestamp + '.' + body)
    .digest('hex')}`;
  try {
    return await fetch(new URL(`/hooks/${endpointKey}`, origin), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pertexo-timestamp': timestamp,
        'x-pertexo-signature': signature,
        'idempotency-key': key,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(
      'Owned signed response request failed; sensitive details omitted.',
    );
  }
}

test('a browser-authored response reaches its original signed caller and work continues', async ({
  page,
  request,
}) => {
  const mail = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  const origin = process.env.PERTEXO_API_PROXY_TARGET;
  if (mail === undefined || origin === undefined)
    throw new Error('Use the owned response fixture');
  await registerEditorUser(page, request, mail, 'Webhook reply owner');
  const workspaceId = await createEditorWorkspace(page, 'Webhook replies');
  const path = await createEditorWorkflow(
    page,
    workspaceId,
    'Webhook response qualification',
  );
  const editorUrl = new URL(page.url()).pathname;
  const workflowId = path.split('/').at(-1);
  if (workflowId === undefined) throw new Error('Workflow missing');
  const webhookId = await add(page, path, /^Webhook\b/u, 'Incoming request');
  await page.getByLabel('Respond to caller', { exact: true }).click();
  await page
    .getByRole('option', { name: 'When the workflow responds', exact: true })
    .click();
  await expect(
    page.getByLabel('Wait time (seconds)', { exact: true }),
  ).toHaveValue('10');
  const respondId = await add(
    page,
    path,
    /^Respond to webhook\b/u,
    'Reply to caller',
  );
  await literal(page, 'body', { accepted: true });
  await literal(page, 'statusCode', 201, true);
  await literal(page, 'headers', { 'x-correlation-id': 'workflow-reply' });
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  await page.getByRole('button', { name: 'Check setup', exact: true }).click();
  await expect(
    page.getByText('Setup looks right', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Run (?:another )?test$/u }).click();
  await expect(page.getByRole('region', { name: 'Test result' })).toContainText(
    'preview',
  );
  const afterId = await add(
    page,
    path,
    /^Set fields\b/u,
    'Continue after reply',
  );
  await literal(page, 'continued', true);
  await expect
    .poll(async () => (await readEditorDraft(page, path)).graph.edges.length)
    .toBe(2);
  const graph = (await readEditorDraft(page, path)).graph;
  expect(graph.edges.map((e) => [e.source.nodeId, e.target.nodeId])).toEqual([
    [webhookId, respondId],
    [respondId, afterId],
  ]);
  await publishSingleStep(page, path);
  await expect
    .poll(async () => {
      const r = await page.request.get(`${path}/triggers`);
      return webhookTriggerListResponseSchema.parse(await r.json()).items[0]
        ?.status;
    })
    .toBe('configuration_required');
  await page.goto(`${editorUrl}/triggers`);
  await page
    .getByRole('article', { name: 'Webhook: Incoming request', exact: true })
    .getByRole('button', { name: 'Create endpoint', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Store these now',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  const codes = await dialog.locator('code').allTextContents();
  // The first code shown is the whole address; the key and secret are the bare values.
  const keys = codes.filter((code) => /^[\w-]{43}$/u.test(code));
  const endpoint = keys[0],
    secret = keys.at(-1);
  if (
    endpoint === undefined ||
    secret === undefined ||
    !(
      /^[A-Za-z0-9_-]{43}$/u.test(endpoint) &&
      /^[A-Za-z0-9_-]{43}$/u.test(secret)
    )
  )
    throw new Error('Transient response credentials missing');
  const key = randomUUID();
  const response = await signed(origin, endpoint, secret, key);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ accepted: true });
  expect(response.headers.get('x-correlation-id')).toBe('workflow-reply');
  expect(response.headers.get('set-cookie')).toBeNull();
  const runs = async () => {
    const r = await page.request.get(
      `/v1/workspaces/${workspaceId}/runs?workflowId=${workflowId}&limit=10`,
    );
    expect(r.status()).toBe(200);
    return workflowRunListResponseSchema.parse(await r.json());
  };
  const run = (await runs()).items[0];
  if (run === undefined) throw new Error('Webhook response run missing');
  expect(run.triggerType).toBe('webhook');
  await waitForRun(page, workspaceId, run.id, 'succeeded');
  const duplicate = await signed(origin, endpoint, secret, key);
  expect(duplicate.status).toBe(201);
  expect(await duplicate.json()).toEqual({ accepted: true });
  expect((await runs()).items).toHaveLength(1);
  await page.goto(editorUrl);
  const manualId = await startSingleStep(page, {});
  await waitForRun(page, workspaceId, manualId, 'succeeded');
});

test('changes authentication through settings and answers a real browser caller with CSV', async ({
  page,
  request,
}) => {
  const mail = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  const origin = process.env.PERTEXO_API_PROXY_TARGET;
  if (mail === undefined || origin === undefined)
    throw new Error('Use the owned response fixture');
  await registerEditorUser(page, request, mail, 'Webhook authentication owner');
  const workspaceId = await createEditorWorkspace(
    page,
    'Webhook authentication',
  );
  const path = await createEditorWorkflow(
    page,
    workspaceId,
    'Webhook authentication qualification',
  );
  const editorUrl = new URL(page.url()).pathname;
  await add(page, path, /^Webhook\b/u, 'Browser request');
  await page.getByLabel('Respond to caller', { exact: true }).click();
  await page
    .getByRole('option', { name: 'When the workflow responds', exact: true })
    .click();
  await add(page, path, /^Respond to webhook\b/u, 'CSV reply');
  await page.getByLabel('Response body', { exact: true }).click();
  await page.getByRole('option', { name: 'Plain text', exact: true }).click();
  await page.getByLabel('Text format', { exact: true }).click();
  await page.getByRole('option', { name: 'CSV', exact: true }).click();
  await literal(page, 'body', 'currency,total\nEUR,42');
  await literal(page, 'headers', { 'X-Total-Count': '1' });
  await publishSingleStep(page, path);
  await expect
    .poll(async () => {
      const response = await page.request.get(`${path}/triggers`);
      return webhookTriggerListResponseSchema.parse(await response.json())
        .items[0]?.status;
    })
    .toBe('configuration_required');
  await page.goto(`${editorUrl}/triggers`);
  const card = page.getByRole('article', {
    name: 'Webhook: Browser request',
    exact: true,
  });
  await card
    .getByRole('button', { name: 'Create endpoint', exact: true })
    .click();
  const reveal = page.getByRole('dialog', {
    name: 'Store these now',
    exact: true,
  });
  await expect(reveal).toBeVisible();
  const firstEndpoint = (await reveal.locator('code').allTextContents()).find(
    (code) => /^[\w-]{43}$/u.test(code),
  );
  if (firstEndpoint === undefined) throw new Error('Endpoint reveal missing');
  await reveal.getByRole('switch', { name: 'I’ve stored these' }).click();
  await reveal.getByRole('button', { name: 'Done', exact: true }).click();
  await page.setViewportSize({ width: 375, height: 768 });
  await card
    .getByRole('button', { name: 'Authentication…', exact: true })
    .click();
  const settings = page.getByRole('dialog', {
    name: 'Webhook authentication',
    exact: true,
  });
  await settings.getByLabel('Authentication mode', { exact: true }).click();
  await page.getByRole('option', { name: 'Secret URL', exact: true }).click();
  await expect(
    settings.getByText(/The URL is the only credential/u),
  ).toBeVisible();
  await settings
    .getByLabel('Allowed browser origins', { exact: true })
    .fill('https://example.com/path');
  await settings
    .getByRole('button', { name: 'Save and rotate credentials', exact: true })
    .click();
  await expect(
    settings.getByLabel('Allowed browser origins', { exact: true }),
  ).toBeFocused();
  await expect(
    settings.getByText(/Use an exact http or https origin/u),
  ).toBeVisible();
  await settings
    .getByLabel('Allowed browser origins', { exact: true })
    .fill(new URL(page.url()).origin);
  await expect(
    settings.getByText(/Use an exact http or https origin/u),
  ).toHaveCount(0);
  await settings
    .getByRole('button', { name: 'Save and rotate credentials', exact: true })
    .click();
  await expect(reveal).toBeVisible();
  const endpoint = (await reveal.locator('code').allTextContents()).find(
    (code) => /^[\w-]{43}$/u.test(code),
  );
  if (endpoint === undefined || endpoint === firstEndpoint)
    throw new Error('Authentication change did not rotate URL');
  await expect(reveal.getByText('Signing secret', { exact: true })).toHaveCount(
    0,
  );
  await reveal.getByRole('switch', { name: 'I’ve stored these' }).click();
  await reveal.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(card).toContainText('Authentication: Secret URL');
  await expect(
    card.getByRole('button', { name: 'Rotate secret', exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const key = randomUUID();
  const response = await page.evaluate(
    async ({ url, key }) => {
      const result = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        credentials: 'omit',
        body: '{}',
      });
      return {
        status: result.status,
        body: await result.text(),
        contentType: result.headers.get('content-type'),
      };
    },
    { url: new URL(`/hooks/${endpoint}`, origin).toString(), key },
  );
  expect(response).toEqual({
    status: 200,
    body: 'currency,total\nEUR,42',
    contentType: 'text/csv; charset=utf-8',
  });
  const duplicate = await fetch(new URL(`/hooks/${endpoint}`, origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  });
  expect(duplicate.status).toBe(200);
  expect(await duplicate.text()).toBe('currency,total\nEUR,42');
  expect(duplicate.headers.get('x-total-count')).toBe('1');
  const old = await fetch(new URL(`/hooks/${firstEndpoint}`, origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(5000),
  });
  expect(old.status).toBe(401);
  await old.arrayBuffer();
  await page.reload();
  await expect(card).toContainText('Authentication: Secret URL');
  await page.screenshot({
    path: '/tmp/pertexo-webhook-auth-phone.png',
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({
    path: '/tmp/pertexo-webhook-auth-desktop.png',
    animations: 'disabled',
  });
});
