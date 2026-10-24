import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { expect, type Locator, type Page } from '@playwright/test';
import {
  workflowDraftResponseSchema,
  workflowNodeRunOutputResponseSchema,
} from '@pertexo/contracts';
import { httpMultipartConfigSchema } from '@pertexo/integrations';
import { test } from '../../support/browser-fixture';
import { createOwnedHttpConnection } from '../../support/authoring/http-connection';
import {
  addSingleStep,
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
  waitForRun,
} from '../../support/authoring/single-step';

const images = '/tmp/pertexo-f04-multipart-screenshots';
const binary = Buffer.from([0, 255, 13, 10, 128]);
const hash = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');

async function setup(page: Page) {
  await page.getByRole('tab', { name: 'Setup', exact: true }).click();
  await page.getByRole('button', { name: 'Edit as JSON', exact: true }).click();
  await page.getByLabel('Setup as JSON', { exact: true }).fill(
    JSON.stringify({
      method: 'POST',
      url: 'https://artifact-owned.example.test/upload',
      headers: {},
      timeoutMillis: 5000,
      maxRedirects: 0,
      maxResponseBytes: 4096,
      inlineResponseBytes: 4096,
    }),
  );
  await page.keyboard.press('Tab');
  await page.getByLabel('HTTP connection', { exact: true }).click();
  await page
    .getByRole('option', { name: 'Owned HTTP credential', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
}

async function addRunInputFileParts(
  page: Page,
  part: (index: number) => Locator,
) {
  for (const name of ['empty', 'response']) {
    await page
      .getByRole('button', { name: 'Add file part', exact: true })
      .click();
    const row = part(name === 'empty' ? 4 : 5);
    await row.getByLabel('Field name', { exact: true }).fill(name);
    await row.getByRole('button', { name: 'Run input', exact: true }).click();
    await row.getByLabel('Run input path', { exact: true }).fill('$.file');
    await row
      .getByLabel('Content type (optional)', { exact: true })
      .fill(name === 'empty' ? 'text/plain' : 'application/json');
  }
}

test('authors multipart at desktop and phone widths, then sends exact ordered parts from uploaded, run-input and response files', async ({
  page,
  request,
}) => {
  await mkdir(images, { recursive: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 768 });
  const { workspaceId, connection } = await createOwnedHttpConnection(
    page,
    request,
  );
  const path = await createEditorWorkflow(
    page,
    workspaceId,
    'Send a multipart form',
  );
  const nodeId = await addSingleStep(page, path, /HTTP request/u, 'Send form');
  await setup(page);
  await page.screenshot({ path: `${images}/before.png` });
  await page.getByRole('button', { name: 'Form parts', exact: true }).click();
  const part = (index: number) =>
    page.getByRole('group', {
      name: new RegExp(`^Part ${String(index)}:`, 'u'),
    });
  await part(1).getByLabel('Field name', { exact: true }).fill('title');
  await part(1).getByLabel('Value', { exact: true }).fill('Invoice € Ready');
  await part(1).getByRole('button', { name: 'Run input', exact: true }).click();
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await part(1).getByLabel('Run input path', { exact: true }).fill('$.title');
  await page
    .getByRole('button', { name: 'Add file part', exact: true })
    .click();
  await part(2).getByLabel('Field name', { exact: true }).fill('document');
  await part(2)
    .getByRole('button', { name: 'Upload part file', exact: true })
    .click();
  await page.getByLabel('File', { exact: true }).setInputFiles({
    name: 'ignored-local-name.bin',
    mimeType: 'application/octet-stream',
    buffer: binary,
  });
  await expect(page.getByText('File ready', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Use file for this part', exact: true })
    .click();
  await part(2)
    .getByLabel('Filename (optional)', { exact: true })
    .fill('invoice.bin');
  await part(2)
    .getByLabel('Content type (optional)', { exact: true })
    .fill('application/octet-stream');
  await page
    .getByRole('button', { name: 'Add text part', exact: true })
    .click();
  await part(3).getByLabel('Field name', { exact: true }).fill('title');
  await part(3).getByLabel('Value', { exact: true }).fill('second');
  await part(3)
    .getByLabel('Filename (optional)', { exact: true })
    .fill('notes.txt');
  await part(3)
    .getByLabel('Content type (optional)', { exact: true })
    .fill('text/x-owned');
  await addRunInputFileParts(page, part);
  await part(5)
    .getByLabel('Filename (optional)', { exact: true })
    .fill('response.json');
  const readNode = async () => {
    const node = (await readEditorDraft(page, path)).graph.nodes.find(
      ({ id }) => id === nodeId,
    );
    if (node === undefined) throw new Error('Multipart step missing');
    return node;
  };
  const readParts = async () =>
    httpMultipartConfigSchema.safeParse((await readNode()).config.multipart)
      .data?.parts ?? [];
  await expect
    .poll(async () =>
      (await readParts()).map(({ name, filename }) => ({ name, filename })),
    )
    .toEqual([
      { name: 'title' },
      { name: 'document', filename: 'invoice.bin' },
      { name: 'title', filename: 'notes.txt' },
      { name: 'empty' },
      { name: 'response', filename: 'response.json' },
    ]);
  const original = await readParts();
  const reordered = [
    original[0],
    original[2],
    original[1],
    original[3],
    original[4],
  ];
  await part(3)
    .getByRole('button', { name: 'Move part up', exact: true })
    .press('Enter');
  await expect(part(2).getByLabel('Field name', { exact: true })).toBeFocused();
  await expect.poll(readParts).toEqual(reordered);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(readParts).toEqual(original);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(readParts).toEqual(reordered);
  await page.getByRole('button', { name: 'Raw body', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await part(1)
    .getByLabel('Field name', { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${images}/after-desktop.png` });
  await page.setViewportSize({ width: 375, height: 768 });
  await page
    .getByRole('navigation', { name: 'Editor panels' })
    .getByRole('button', { name: 'Step', exact: true })
    .click();
  await part(1)
    .getByLabel('Field name', { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${images}/after-phone.png` });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 768 });
  await page.reload();
  const saved = await readNode();
  expect(JSON.stringify(saved)).not.toContain('ignored-local-name.bin');
  expect(httpMultipartConfigSchema.parse(saved.config.multipart).parts).toEqual(
    reordered,
  );
  // The preceding HTTP response is independently retained as a checked file.
  const response = await page.request.get(`${path}/draft`);
  const { graph } = workflowDraftResponseSchema.parse(await response.json());
  const responsePart = original.find(({ name }) => name === 'response');
  const cookie = (await page.context().cookies()).find(
    ({ name }) => name === 'pertexo_csrf',
  );
  if (responsePart === undefined || cookie === undefined)
    throw new Error('Owned multipart authoring context missing');
  expect(
    (
      await page.request.put(`${path}/draft`, {
        headers: {
          'x-csrf-token': decodeURIComponent(cookie.value),
          'If-Match': response.headers().etag ?? '',
        },
        data: {
          graph: {
            ...graph,
            nodes: [
              {
                id: 'response-source',
                label: 'Get response file',
                definition: { key: 'http.request', version: 1 },
                configVersion: 1,
                position: { x: 0, y: 0 },
                config: {
                  method: 'POST',
                  url: 'https://artifact-owned.example.test/upload',
                  headers: {},
                  timeoutMillis: 5000,
                  maxRedirects: 0,
                  maxResponseBytes: 4096,
                  inlineResponseBytes: 1,
                },
                inputMappings: {
                  body: {
                    kind: 'literal',
                    value: {
                      encoding: 'utf8',
                      value: 'multipart response source',
                    },
                  },
                },
                connectionRefs: { http_headers: connection.id },
              },
              {
                ...saved,
                position: { x: 400, y: 0 },
                inputMappings: {
                  ...saved.inputMappings,
                  [responsePart.inputKey]: {
                    kind: 'node_output',
                    nodeId: 'response-source',
                    path: '$.body',
                  },
                },
              },
            ],
            edges: [
              {
                id: 'response-link',
                source: { nodeId: 'response-source', port: 'out' },
                target: { nodeId, port: 'in' },
              },
            ],
          },
        },
      })
    ).status(),
  ).toBe(200);
  await page.reload();
  await publishSingleStep(page, path);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Run with input…', exact: true })
    .click();
  await page
    .getByLabel('Run input (JSON)', { exact: true })
    .fill(JSON.stringify({ title: 'Invoice €\nReady' }));
  await page.getByRole('button', { name: 'Upload file', exact: true }).click();
  await page.getByLabel('File', { exact: true }).setInputFiles({
    name: 'empty.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(0),
  });
  await expect(page.getByText('File ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use file', exact: true }).click();
  await page
    .getByRole('button', { name: 'Start published version', exact: true })
    .click();
  await expect(page).toHaveURL(/\/runs\/[^/]+$/u);
  const runId = new URL(page.url()).pathname.split('/')[4];
  if (runId === undefined) throw new Error('Multipart run missing');
  const run = await waitForRun(page, workspaceId, runId, 'succeeded');
  expect(run.nodes.map(({ status }) => status)).toEqual([
    'succeeded',
    'succeeded',
  ]);
  const target = run.nodes.find(({ nodeId: id }) => id === nodeId);
  if (target === undefined) throw new Error('Multipart node not executed');
  const output = workflowNodeRunOutputResponseSchema.parse(
    await (
      await page.request.get(
        `/v1/workspaces/${workspaceId}/runs/${runId}/node-runs/${target.id}/output`,
      )
    ).json(),
  );
  if (output.output.kind !== 'inline')
    throw new Error('Expected inline observation');
  const value = output.output.value;
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof value.body !== 'object' ||
    value.body === null ||
    Array.isArray(value.body) ||
    typeof value.body.value !== 'string'
  )
    throw new Error('Expected HTTP observation body');
  const observation: unknown = JSON.parse(value.body.value);
  expect(observation).toMatchObject({
    wireBytes: expect.any(Number),
    wireSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    parts: [
      {
        name: 'title',
        filename: null,
        contentType: 'text/plain; charset=utf-8',
        byteLength: Buffer.byteLength('Invoice €\nReady'),
        sha256: hash('Invoice €\nReady'),
      },
      {
        name: 'title',
        filename: 'notes.txt',
        contentType: 'text/x-owned',
        byteLength: 6,
        sha256: hash('second'),
      },
      {
        name: 'document',
        filename: 'invoice.bin',
        contentType: 'application/octet-stream',
        byteLength: 5,
        sha256: hash(binary),
      },
      {
        name: 'empty',
        filename: 'file',
        contentType: 'text/plain',
        byteLength: 0,
        sha256: hash(''),
      },
      {
        name: 'response',
        filename: 'response.json',
        contentType: 'application/json',
        byteLength: 2,
        sha256: hash('{}'),
      },
    ],
  });
  if (
    typeof observation !== 'object' ||
    observation === null ||
    !('wireBytes' in observation) ||
    typeof observation.wireBytes !== 'number'
  )
    throw new Error('Wire size missing');
  expect(observation.wireBytes).toBeGreaterThan(100);
  expect(observation.wireBytes).toBeLessThanOrEqual(1048576);
});
