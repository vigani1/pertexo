import { csrfHeaders } from '../../../test/support/browser/csrf';
import { mkdir } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { test } from '../../support/browser-fixture';
import { createOwnedHttpConnection } from '../../support/authoring/http-connection';
import {
  addSingleStep,
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
  startSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';

const images = '/tmp/pertexo-f04-read-screenshots';
async function upload(page: Page, buffer: Buffer) {
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page
    .getByRole('button', { name: 'Upload file to read', exact: true })
    .click();
  await page
    .getByLabel('File', { exact: true })
    .setInputFiles({ name: 'export.csv', mimeType: 'text/csv', buffer });
  await expect(page.getByText('File ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use file', exact: true }).click();
}

test('uploads CSV in the editor, reads default-converted values and runs Filter → Summarize → Stop', async ({
  page,
  request,
}) => {
  await mkdir(images, { recursive: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { workspaceId } = await createOwnedHttpConnection(page, request);
  const path = await createEditorWorkflow(
    page,
    workspaceId,
    'Read currency export',
  );
  const readId = await addSingleStep(
    page,
    path,
    /Read file/u,
    'Read currency export',
  );
  await expect(
    page.getByRole('switch', {
      name: 'Convert numbers and booleans',
      exact: true,
    }),
  ).toBeChecked();
  await expect(page.getByText(/roughly 5,000 short rows/u)).toBeVisible();
  await page.screenshot({ path: `${images}/setup-desktop.png` });
  await page.setViewportSize({ width: 375, height: 768 });
  await page
    .getByRole('navigation', { name: 'Editor panels' })
    .getByRole('button', { name: 'Step', exact: true })
    .click();
  await page.screenshot({ path: `${images}/setup-phone.png` });
  await upload(
    page,
    Buffer.from(
      'currency,amount,paid\nEUR,12.5,true\nEUR,7.5,true\nUSD,9,true\nEUR,100,false',
    ),
  );
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, path)).graph.nodes[0]?.inputMappings.file,
    )
    .toMatchObject({ kind: 'literal', value: { kind: 'artifact' } });
  await page.setViewportSize({ width: 1280, height: 768 });
  await page.keyboard.press('Escape');
  const response = await page.request.get(`${path}/draft`);
  const { graph } = await readEditorDraft(page, path);
  function node({
    id,
    key,
    config,
    inputMappings,
    x,
  }: Readonly<{
    id: string;
    key: string;
    config: WorkflowGraphContract['nodes'][number]['config'];
    inputMappings: WorkflowGraphContract['nodes'][number]['inputMappings'];
    x: number;
  }>) {
    return {
      id,
      label: id,
      definition: { key, version: 1 },
      configVersion: 1,
      config,
      inputMappings,
      connectionRefs: {},
      position: { x, y: 0 },
    };
  }
  const nodes = [
    ...graph.nodes,
    node({
      id: 'paid',
      key: 'core.filter',
      config: { path: '$.paid', operator: 'equals' },
      inputMappings: {
        items: { kind: 'node_output', nodeId: readId, path: '$' },
        value: { kind: 'literal', value: true },
      },
      x: 320,
    }),
    node({
      id: 'totals',
      key: 'core.summarize',
      config: {
        valuePath: '$.amount',
        groupBy: '$.currency',
        missing: 'error',
      },
      inputMappings: {
        items: { kind: 'node_output', nodeId: 'paid', path: '$.items' },
      },
      x: 640,
    }),
    node({
      id: 'finished',
      key: 'core.terminate',
      config: {},
      inputMappings: {
        totals: { kind: 'node_output', nodeId: 'totals', path: '$' },
      },
      x: 960,
    }),
  ];
  const order = [readId, 'paid', 'totals', 'finished'];
  const edges = order.slice(1).map((id, index) => ({
    id: `link-${String(index)}`,
    source: { nodeId: order[index] ?? '', port: 'out' },
    target: { nodeId: id, port: 'in' },
  }));
  expect(
    (
      await page.request.put(`${path}/draft`, {
        headers: {
          ...(await csrfHeaders(page)),
          'If-Match': response.headers().etag ?? '',
        },
        data: { graph: { ...graph, nodes, edges } },
      })
    ).status(),
  ).toBe(200);
  await page.reload();
  await publishSingleStep(page, path);
  const runId = await startSingleStep(page, {});
  const run = await waitForRun(page, workspaceId, runId, 'succeeded');
  const summary = run.nodes.find((item) => item.nodeId === 'totals');
  if (summary === undefined) throw new Error('Summary not executed');
  const output = await page.request.get(
    `/v1/workspaces/${workspaceId}/runs/${runId}/node-runs/${summary.id}/output`,
  );
  expect(await output.json()).toMatchObject({
    output: {
      kind: 'inline',
      value: {
        groups: [
          { key: 'EUR', count: 2, sum: 20 },
          { key: 'USD', count: 1, sum: 9 },
        ],
      },
    },
  });
});

test('shows a persisted malformed-file diagnostic after reload without echoing contents', async ({
  page,
  request,
}) => {
  const { workspaceId } = await createOwnedHttpConnection(page, request);
  const path = await createEditorWorkflow(page, workspaceId, 'Malformed CSV');
  await addSingleStep(page, path, /Read file/u, 'Read malformed export');
  await upload(
    page,
    Buffer.from('currency,amount\nEUR,12\nprivate-redaction-sentinel'),
  );
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, path)).graph.nodes[0]?.inputMappings.file,
    )
    .toMatchObject({ kind: 'literal' });
  await page.keyboard.press('Escape');
  await publishSingleStep(page, path);
  const runId = await startSingleStep(page, {});
  const run = await waitForRun(page, workspaceId, runId, 'failed');
  expect(run.nodes[0]).toMatchObject({
    safeErrorCode: 'execution.file_input',
    errorSummary:
      'CSV record 3 has 1 column; the header has 2. Check the delimiter and quoting, then upload the corrected file.',
  });
  expect(JSON.stringify(run)).not.toContain('private-redaction-sentinel');
  await page.reload();
  await page
    .getByRole('button', { name: /Read malformed export/u })
    .first()
    .click();
  await expect(page.getByText(/CSV record 3 has 1 column/u)).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain(
    'private-redaction-sentinel',
  );
  await page.screenshot({ path: `${images}/malformed-diagnostic.png` });
});

test('reads an earlier HTTP response file and automatically retries only that safe step after a temporary read outage', async ({
  page,
  request,
}) => {
  const { workspaceId, connection } = await createOwnedHttpConnection(
    page,
    request,
  );
  const path = await createEditorWorkflow(
    page,
    workspaceId,
    'Retry file read only',
  );
  await addSingleStep(page, path, /Read file/u, 'Temporary setup');
  const draft = await page.request.get(`${path}/draft`);
  const graph: WorkflowGraphContract = {
    settings: {},
    nodes: [
      {
        id: 'one-http-effect',
        label: 'One HTTP effect',
        definition: { key: 'http.request', version: 1 },
        configVersion: 1,
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
            value: { encoding: 'utf8', value: 'one earlier effect' },
          },
        },
        connectionRefs: { http_headers: connection.id },
        position: { x: 0, y: 0 },
      },
      {
        id: 'retry-reader',
        label: 'Read response after outage',
        definition: { key: 'core.read_file', version: 1 },
        configVersion: 1,
        config: { format: 'json' },
        inputMappings: {
          file: {
            kind: 'node_output',
            nodeId: 'one-http-effect',
            path: '$.body',
          },
        },
        connectionRefs: {},
        position: { x: 320, y: 0 },
      },
    ],
    edges: [
      {
        id: 'response-link',
        source: { nodeId: 'one-http-effect', port: 'out' },
        target: { nodeId: 'retry-reader', port: 'in' },
      },
    ],
  };
  expect(
    (
      await page.request.put(`${path}/draft`, {
        headers: {
          ...(await csrfHeaders(page)),
          'If-Match': draft.headers().etag ?? '',
        },
        data: { graph },
      })
    ).status(),
  ).toBe(200);
  await page.reload();
  await publishSingleStep(page, path);
  const runId = await startSingleStep(page, {});
  const run = await waitForRun(page, workspaceId, runId, 'succeeded');
  expect(
    run.nodes.find((node) => node.nodeId === 'one-http-effect'),
  ).toMatchObject({ status: 'succeeded', currentAttemptNumber: 1 });
  const reader = run.nodes.find((node) => node.nodeId === 'retry-reader');
  expect(reader).toMatchObject({
    status: 'succeeded',
    currentAttemptNumber: 2,
  });
  if (reader === undefined) throw new Error('Response reader missing');
  const output = await page.request.get(
    `/v1/workspaces/${workspaceId}/runs/${runId}/node-runs/${reader.id}/output`,
  );
  expect(await output.json()).toEqual({
    output: { kind: 'inline', value: {} },
  });
});

test('reads a JSON file supplied through manual run input', async ({
  page,
  request,
}) => {
  const { workspaceId } = await createOwnedHttpConnection(page, request);
  const path = await createEditorWorkflow(
    page,
    workspaceId,
    'Read manual JSON file',
  );
  await addSingleStep(page, path, /Read file/u, 'Read orders');
  await page.getByLabel('File format', { exact: true }).click();
  await page.getByRole('option', { name: 'JSON', exact: true }).click();
  await expect
    .poll(
      async () => (await readEditorDraft(page, path)).graph.nodes[0]?.config,
    )
    .toEqual({ format: 'json' });
  await page.keyboard.press('Escape');
  const response = await page.request.get(`${path}/draft`);
  const { graph } = await readEditorDraft(page, path);
  expect(
    (
      await page.request.put(`${path}/draft`, {
        headers: {
          ...(await csrfHeaders(page)),
          'If-Match': response.headers().etag ?? '',
        },
        data: {
          graph: {
            ...graph,
            nodes: graph.nodes.map((node) => ({
              ...node,
              inputMappings: { file: { kind: 'run_input', path: '$.file' } },
            })),
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
  await page.getByRole('button', { name: 'Upload file', exact: true }).click();
  await page.getByLabel('File', { exact: true }).setInputFiles({
    name: 'orders.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"orders":[{"amount":12.5}]}'),
  });
  await expect(page.getByText('File ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use file', exact: true }).click();
  await page
    .getByRole('button', { name: 'Start published version', exact: true })
    .click();
  await expect(page).toHaveURL(/\/runs\/[^/]+$/u);
  const runId = new URL(page.url()).pathname.split('/')[4];
  if (runId === undefined) throw new Error('Manual run missing');
  const run = await waitForRun(page, workspaceId, runId, 'succeeded');
  const reader = run.nodes[0];
  if (reader === undefined) throw new Error('Reader missing');
  const output = await page.request.get(
    `/v1/workspaces/${workspaceId}/runs/${runId}/node-runs/${reader.id}/output`,
  );
  expect(await output.json()).toEqual({
    output: { kind: 'inline', value: { orders: [{ amount: 12.5 }] } },
  });
});
