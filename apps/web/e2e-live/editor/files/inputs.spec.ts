import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { expect, request as requestFactory, type Page } from '@playwright/test';
import { test } from '../../support/browser-fixture';
import { createOwnedHttpConnection } from '../../support/authoring/http-connection';
import {
  createEditorWorkflow,
  readEditorDraft,
  publishSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';

const bytes = Buffer.alloc(1048576);
for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
const sha256 = createHash('sha256').update(bytes).digest('hex');
const images = '/tmp/pertexo-f04-screenshots';

async function add(
  page: Page,
  workflowPath: string,
  kind: RegExp,
  label: string,
) {
  const before = (await readEditorDraft(page, workflowPath)).graph.nodes;
  await page
    .getByRole('complementary', { name: 'Add a step' })
    .getByRole('button', { name: kind })
    .click();
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes.length,
    )
    .toBe(before.length + 1);
  const node = (await readEditorDraft(page, workflowPath)).graph.nodes.find(
    (item) => !before.some(({ id }) => id === item.id),
  );
  if (node === undefined) throw new Error('Browser-authored file step missing');
  await page.getByTestId(`rf__node-${node.id}`).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Label', { exact: true }).fill(label);
  await page.keyboard.press('Tab');
  return node.id;
}
async function setupHttp(page: Page, artifactResponse: boolean) {
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
      inlineResponseBytes: artifactResponse ? 1 : 4096,
    }),
  );
  await page.keyboard.press('Tab');
  await page.getByLabel('HTTP connection', { exact: true }).click();
  await page
    .getByRole('option', { name: 'Owned HTTP credential', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
}
async function map({
  page,
  workflowPath,
  targetId,
  source,
  path,
  step,
}: Readonly<{
  page: Page;
  workflowPath: string;
  targetId: string;
  source: 'Run input' | 'Step output';
  path: string;
  step?: string;
}>) {
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  const row = page
    .getByRole('region', { name: 'Inputs', exact: true })
    .locator('ol > li')
    .last();
  await row.getByLabel('Field', { exact: true }).fill('body');
  await row.getByRole('button', { name: source, exact: true }).click();
  if (source === 'Run input')
    await row.getByLabel('Run input path', { exact: true }).fill(path);
  else {
    if (step === undefined)
      throw new Error('Step-output fixture needs a source step');
    await row.getByLabel('Source step', { exact: true }).click();
    await page.getByRole('option', { name: step, exact: true }).click();
    await row.getByLabel('Output path', { exact: true }).fill(path);
  }
  await page.keyboard.press('Tab');
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes.find(
          ({ id }) => id === targetId,
        )?.inputMappings.body,
    )
    .toMatchObject({
      kind: source === 'Run input' ? 'run_input' : 'node_output',
      path,
    });
}
async function beginRun(page: Page) {
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Run with input…', exact: true })
    .click();
}
async function submitRun(page: Page, workspaceId: string) {
  await page
    .getByRole('button', { name: 'Start published version', exact: true })
    .click();
  await expect(page).toHaveURL(/\/runs\/[^/]+$/u);
  const runId = new URL(page.url()).pathname.split('/')[4];
  if (runId === undefined) throw new Error('File run ID missing');
  try {
    await waitForRun(page, workspaceId, runId, 'succeeded');
  } catch {
    const response = await page.request.get(
      `/v1/workspaces/${workspaceId}/runs/${runId}`,
    );
    const value = (await response.json()) as {
      nodes: { status: string; safeErrorCode: string | null }[];
    };
    process.stdout.write(
      `Owned file run node outcomes ${JSON.stringify(value.nodes.map(({ status, safeErrorCode }) => ({ status, safeErrorCode })))}\n`,
    );
    throw new Error('Owned file run did not succeed');
  }
}

for (const manual of [false, true])
  test(`uploads a signed file from ${manual ? 'manual run input' : 'the editor'}, persists it and sends exact bytes through a response-artifact chain`, async ({
    page,
    request,
  }) => {
    await mkdir(images, { recursive: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { workspaceId, connection } = await createOwnedHttpConnection(
      page,
      request,
    );
    let signedUrl: string | undefined;
    page.on('request', (outgoing) => {
      if (
        outgoing.method() === 'PUT' &&
        new URL(outgoing.url()).searchParams.has('X-Amz-Signature')
      )
        signedUrl = outgoing.url();
    });
    await page.setViewportSize({ width: 1280, height: 768 });
    const workflowPath = await createEditorWorkflow(
      page,
      workspaceId,
      manual ? 'File from run input' : 'File from saved draft',
    );
    await add(page, workflowPath, /Manual/u, 'File start');
    const httpId = await add(
      page,
      workflowPath,
      /HTTP request/u,
      'Send selected file',
    );
    await setupHttp(page, true);
    await expect
      .poll(
        async () =>
          (await readEditorDraft(page, workflowPath)).graph.nodes.find(
            ({ id }) => id === httpId,
          )?.connectionRefs,
      )
      .toEqual({ http_headers: connection.id });
    if (manual)
      await map({
        page,
        workflowPath,
        targetId: httpId,
        source: 'Run input',
        path: '$.file',
      });
    else {
      await page.screenshot({ path: `${images}/editor-before.png` });
      await page.setViewportSize({ width: 375, height: 768 });
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Step', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Upload body file', exact: true })
        .click();
      const heap = await page.context().newCDPSession(page);
      const before: unknown = await heap.send('Runtime.getHeapUsage');
      const started = performance.now();
      await page
        .getByLabel('File', { exact: true })
        .setInputFiles({ name: 'opaque.bin', mimeType: '', buffer: bytes });
      await expect(page.getByText('File ready', { exact: true })).toBeVisible();
      const upload = page.getByRole('dialog', {
        name: 'Upload a file',
        exact: true,
      });
      await expect(
        upload.getByText('opaque.bin', { exact: true }),
      ).toBeVisible();
      await expect(upload.getByText('1 MB', { exact: true })).toBeVisible();
      const after: unknown = await heap.send('Runtime.getHeapUsage');
      process.stdout.write(
        `Owned 1 MiB browser upload observation ${JSON.stringify({ durationMs: Math.round(performance.now() - started), before, after })}\n`,
      );
      await heap.detach();
      await page.screenshot({ path: `${images}/editor-upload-phone.png` });
      await page.setViewportSize({ width: 1280, height: 768 });
      await page.screenshot({ path: `${images}/editor-upload-desktop.png` });
      await page.setViewportSize({ width: 375, height: 768 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page
        .getByRole('button', { name: 'Use file as body', exact: true })
        .press('Enter');
      await expect(
        page.getByRole('button', { name: 'Upload body file', exact: true }),
      ).toBeFocused();
      await page.setViewportSize({ width: 1280, height: 768 });
      await expect
        .poll(
          async () =>
            (await readEditorDraft(page, workflowPath)).graph.nodes.find(
              ({ id }) => id === httpId,
            )?.inputMappings.body,
        )
        .toMatchObject({
          kind: 'literal',
          value: { kind: 'artifact', byteLength: bytes.length, sha256 },
        });
      // The finalized descriptor is one independent history edit.
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect
        .poll(
          async () =>
            (await readEditorDraft(page, workflowPath)).graph.nodes.find(
              ({ id }) => id === httpId,
            )?.inputMappings.body,
        )
        .toBeUndefined();
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await expect
        .poll(
          async () =>
            (await readEditorDraft(page, workflowPath)).graph.nodes.find(
              ({ id }) => id === httpId,
            )?.inputMappings.body,
        )
        .toMatchObject({ kind: 'literal', value: { sha256 } });
    }
    const responseId = await add(
      page,
      workflowPath,
      /HTTP request/u,
      'Send response file',
    );
    await setupHttp(page, false);
    await expect
      .poll(async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes
          .filter(({ definition }) => definition.key === 'http.request')
          .map(({ connectionRefs }) => connectionRefs),
      )
      .toEqual([
        { http_headers: connection.id },
        { http_headers: connection.id },
      ]);
    await map({
      page,
      workflowPath,
      targetId: responseId,
      source: 'Step output',
      path: '$.body',
      step: 'Send selected file',
    });
    const saved = (await readEditorDraft(page, workflowPath)).graph;
    await page.reload();
    expect((await readEditorDraft(page, workflowPath)).graph).toEqual(saved);
    await publishSingleStep(page, workflowPath);
    await beginRun(page);
    if (manual) {
      await page.setViewportSize({ width: 375, height: 768 });
      await page.screenshot({ path: `${images}/manual-before.png` });
      await page
        .getByRole('button', { name: 'Upload file', exact: true })
        .click();
      await page.getByLabel('File', { exact: true }).setInputFiles({
        name: 'empty.bin',
        mimeType: '',
        buffer: Buffer.alloc(0),
      });
      await expect(page.getByText('File ready', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Use file', exact: true }).focus();
      await page.screenshot({ path: `${images}/manual-upload-phone.png` });
      await page.getByRole('button', { name: 'Use file', exact: true }).click();
      await expect
        .poll(
          async () =>
            JSON.parse(
              await page
                .getByLabel('Run input (JSON)', { exact: true })
                .inputValue(),
            ) as unknown,
        )
        .toMatchObject({
          file: {
            kind: 'artifact',
            byteLength: 0,
            sha256: createHash('sha256').digest('hex'),
          },
        });
    }
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.tagName))
      .not.toBe('BODY');
    await submitRun(page, workspaceId);
    if (process.env.PERTEXO_ARTIFACT_SIGNATURE_QUALIFICATION !== 'true') return;
    // Real provider signatures must reject a forged capability. Never print the URL.
    if (signedUrl === undefined)
      throw new Error('No browser signed transfer observed');
    const forged = new URL(signedUrl);
    forged.searchParams.set('X-Amz-Signature', '0'.repeat(64));
    const isolated = await requestFactory.newContext();
    try {
      const response = await isolated.put(forged.href, {
        data: Buffer.alloc(0),
        headers: { 'content-type': 'application/octet-stream' },
      });
      expect(response.status()).toBe(403);
    } catch {
      throw new Error(
        'Owned signature rejection check failed; capability details omitted.',
      );
    } finally {
      await isolated.dispose();
    }
  });
