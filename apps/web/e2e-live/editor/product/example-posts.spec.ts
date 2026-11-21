import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, type Page } from '@playwright/test';
import {
  connectionResponseSchema,
  connectionTestResponseSchema,
  workflowNodeRunOutputResponseSchema,
} from '@pertexo/contracts';
import { test } from './account';
import { openNewEditorWorkspace } from '../../support/ordinary-editor-session';
import { fillOwnedHttpCredential } from '../../support/http-secret-actions';
import {
  addSingleStep,
  createEditorWorkflow,
  publishSingleStep,
  startSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';

const storedPost = {
  id: 2,
  userId: 1,
  title: 'An example post',
  body: 'The worker read this from the local stand-in.',
};

test('creates and tests API-key credentials, then reads a post in a published run', async ({
  page,
}) => {
  const key = randomUUID();
  const rejectedKey = randomUUID();
  const requests: { path: string; authorized: boolean }[] = [];
  const server = createServer((request, response) => {
    const path = request.url;
    if (
      request.method !== 'GET' ||
      (path !== '/posts/1' && path !== '/posts/2')
    ) {
      response.writeHead(404).end();
      return;
    }
    const supplied = request.headers['x-api-key'];
    const authorized = supplied === key;
    requests.push({ path, authorized });
    if (!authorized) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        ...storedPost,
        id: path === '/posts/1' ? 1 : storedPost.id,
        echoedHeader: supplied,
      }),
    );
  });
  const port = Number(process.env.PERTEXO_LIVE_PROVIDER_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Use the owned product fixture');
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  try {
    const workspaceId = await openNewEditorWorkspace(
      page,
      'Example Posts workspace',
    );
    await page.goto(`/w/${workspaceId}/connections`);
    await saveAndTestConnection(page, workspaceId, {
      name: 'Rejected Example Posts',
      key: rejectedKey,
      accepted: false,
    });
    await saveAndTestConnection(page, workspaceId, {
      name: 'Readable Example Posts',
      key,
      accepted: true,
    });
    expect((await page.content()).includes(key)).toBe(false);
    expect((await page.content()).includes(rejectedKey)).toBe(false);

    const workflowPath = await createEditorWorkflow(
      page,
      workspaceId,
      'Read Example Posts',
    );
    const nodeId = await addSingleStep(
      page,
      workflowPath,
      /^Get post\b/u,
      'Read one post',
    );
    await page
      .getByLabel('Post ID', { exact: true })
      .fill(String(storedPost.id));
    await page.getByLabel('Example Posts connection', { exact: true }).click();
    await page
      .getByRole('option', { name: 'Readable Example Posts', exact: true })
      .click();
    await publishSingleStep(page, workflowPath);
    const runId = await startSingleStep(page, {});
    const run = await waitForRun(page, workspaceId, runId, 'succeeded');
    expect(JSON.stringify(run).includes(key)).toBe(false);

    const step = run.nodes.find((entry) => entry.nodeId === nodeId);
    if (step === undefined)
      throw new Error('Published run is missing its step');
    const output = await page.request.get(
      `/v1/workspaces/${workspaceId}/runs/${runId}/node-runs/${step.id}/output`,
    );
    expect(output.status()).toBe(200);
    const text = await output.text();
    expect(text.includes(key)).toBe(false);
    expect(workflowNodeRunOutputResponseSchema.parse(JSON.parse(text))).toEqual(
      {
        output: { kind: 'inline', value: { post: storedPost } },
      },
    );
    await page
      .getByRole('button', { name: /^Read one post: Succeeded/u })
      .click();
    const details = page.getByRole('complementary', { name: 'Step details' });
    await expect(details).toContainText(storedPost.title);
    expect((await page.content()).includes(key)).toBe(false);
    expect(requests).toEqual([
      { path: '/posts/1', authorized: false },
      { path: '/posts/1', authorized: true },
      { path: '/posts/2', authorized: true },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }
});

async function saveAndTestConnection(
  page: Page,
  workspaceId: string,
  {
    name,
    key,
    accepted,
  }: Readonly<{ name: string; key: string; accepted: boolean }>,
) {
  const collection = `/v1/workspaces/${workspaceId}/connections`;
  await page
    .getByRole('button', { name: 'Add connection', exact: true })
    .click();
  const tile = 'Connect Example Posts';
  await page
    .getByRole('dialog', { name: 'Add a connection', exact: true })
    .getByRole('button', { name: tile, exact: true })
    .click();
  const form = page.getByRole('dialog', { name: tile, exact: true });
  const field = form.getByLabel('Example Posts API key', { exact: true });
  await expect(field).toHaveAttribute('type', 'password');
  await fillOwnedHttpCredential(field, key);
  await form.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Connection name', { exact: true }).fill(name);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === collection,
  );
  await page
    .getByRole('button', { name: 'Save and test', exact: true })
    .click();
  const created = await saved;
  expect(created.status()).toBe(201);
  const createdBody = await created.text();
  expect(createdBody.includes(key)).toBe(false);
  const { id } = connectionResponseSchema.parse(JSON.parse(createdBody));
  const tested = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `${collection}/${id}/test`,
  );
  await page
    .getByRole('button', { name: 'Test connection', exact: true })
    .click();
  const result = await tested;
  expect(result.status()).toBe(200);
  const resultBody = await result.text();
  expect(resultBody.includes(key)).toBe(false);
  expect(
    connectionTestResponseSchema.parse(JSON.parse(resultBody)).outcome,
  ).toEqual(
    accepted
      ? { ok: true, httpStatus: 200, errorCode: null }
      : {
          ok: false,
          httpStatus: 401,
          errorCode: 'connection.credential_rejected',
        },
  );
  await expect(
    page.getByText(
      `Example Posts ${accepted ? 'accepted' : 'rejected'} the API key.`,
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
}
