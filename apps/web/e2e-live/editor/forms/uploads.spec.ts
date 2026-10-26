import { mkdir } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { pendingTaskListResponseSchema } from '@pertexo/contracts';
import { readCsrfToken } from '../../../test/support/browser/csrf';
import {
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
  waitForRun,
} from '../../support/authoring/single-step';
import { test } from '../../support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from '../../support/ordinary-editor-session';
import { formUploadsGraph } from './uploads-graph';

// Opt in to the full size and theme matrix; otherwise two plain screenshots.
const shots = process.env.PERTEXO_FEATURE_SHOTS;
const directory = shots ?? '/tmp/pertexo-form-upload-screenshots';
const sizes = shots
  ? ([
      [360, 740],
      [390, 844],
      [768, 1024],
      [1024, 768],
      [1440, 900],
      [1920, 1080],
    ] as const)
  : ([[1280, 768]] as const);
const schemes = shots ? (['light', 'dark'] as const) : (['light'] as const);

const orders = Buffer.from('sku,qty\nA-1,2\nB-2,5\n');
const csv = (name: string, buffer: Buffer) => ({
  name,
  mimeType: 'text/csv',
  buffer,
});

async function capture(
  page: Page,
  name: string,
  prepare: () => Promise<void> = () => Promise.resolve(),
) {
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      await prepare();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `${directory}/${name}-${String(width)}x${String(height)}-${scheme}.png`,
        fullPage: true,
      });
    }
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 768 });
}

async function respond(responder: Page, shop: string, url: string) {
  await responder.goto(url);
  await expect(
    responder.getByRole('heading', {
      name: 'Send this month’s orders',
      exact: true,
    }),
  ).toBeVisible();
  const zone = responder.getByLabel('Orders export', { exact: true });
  await expect(zone).toHaveAccessibleDescription(/Excel, CSV · up to 1 MB/u);
  const files = responder.getByRole('list', { name: 'Orders export files' });
  // Too large: refused in place before anything is uploaded.
  await zone.setInputFiles(csv('everything.csv', Buffer.alloc(1_572_864, 65)));
  await expect(
    files.getByText('This file is 1.5 MB; the limit is 1 MB.', {
      exact: false,
    }),
  ).toBeVisible();
  await files
    .getByRole('button', { name: 'Remove everything.csv', exact: true })
    .click();
  await zone.setInputFiles(csv('orders.csv', orders));
  await expect(files.getByText(/Attached/u)).toBeVisible();
  await responder.getByLabel('Shop', { exact: true }).fill(shop);
  const submitted = responder.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/submit'),
  );
  await responder
    .getByRole('button', { name: 'Send response', exact: true })
    .click();
  expect((await submitted).status()).toBe(200);
  await expect(
    responder.getByRole('heading', { name: 'Response sent', exact: true }),
  ).toBeVisible();
}

async function completeRequest(page: Page, workspaceId: string) {
  let runId = '';
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/v1/workspaces/${workspaceId}/pending-tasks?view=all&status=pending&kind=input_request`,
      );
      const tasks = pendingTaskListResponseSchema.parse(await response.json());
      runId = tasks.items[0]?.runId ?? '';
      return tasks.items.length;
    })
    .toBe(1);
  await page.goto(`/w/${workspaceId}/inbox`);
  await page
    .getByRole('navigation', { name: 'Inbox views' })
    .getByRole('link', { name: /^Requests/u })
    .click();
  await page
    .getByRole('main')
    .getByRole('link', { name: 'Upload the signed delivery note', exact: true })
    .click();
  const note = page.getByLabel('Signed delivery note', { exact: true });
  await note.setInputFiles({
    name: 'signed-note.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\n% signed\n'),
  });
  await expect(
    page
      .getByRole('list', { name: 'Signed delivery note files' })
      .getByText(/Attached/u),
  ).toBeVisible();
  return runId;
}

test('form and input request uploads reach the run as files that Read file reads', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(240000);
  await mkdir(directory, { recursive: true });
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Owned mail missing');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await registerEditorUser(page, request, mailOrigin, 'Form owner');
  const workspaceId = await createEditorWorkspace(page, 'Form uploads');
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Collect orders',
  );
  const workflowId = workflowPath.split('/').at(-1) ?? '';
  const draft = await page.request.get(`${workflowPath}/draft`);
  const saved = await page.request.put(`${workflowPath}/draft`, {
    headers: {
      'If-Match': draft.headers().etag ?? '',
      'x-csrf-token': await readCsrfToken(page),
    },
    data: { graph: formUploadsGraph() },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  await page.reload();
  await page.getByTestId('rf__node-form').focus();
  await page.keyboard.press('Enter');
  const field = page.getByRole('region', { name: 'Field 2', exact: true });
  await expect(field.getByLabel('Type', { exact: true })).toHaveValue('file');
  const accepts = field.getByRole('group', { name: 'Accepts', exact: true });
  await accepts.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes[0]?.config
          .fields,
    )
    .toMatchObject([
      { name: 'shop' },
      { name: 'orders', accept: ['documents', 'spreadsheets'] },
    ]);
  await accepts.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes[0]?.config
          .fields,
    )
    .toMatchObject([{}, { accept: ['spreadsheets'], maxBytes: 1_048_576 }]);
  await capture(page, 'setup', async () => {
    // Phones show the step in a panel the bottom bar opens.
    const panels = page.getByRole('navigation', { name: 'Editor panels' });
    if (!(await accepts.isVisible()) && (await panels.isVisible()))
      await panels.getByRole('button', { name: 'Step', exact: true }).click();
    await accepts.scrollIntoViewIfNeeded({ timeout: 5000 });
  });
  await publishSingleStep(page, workflowPath);
  await page
    .getByRole('button', { name: 'Enable public link', exact: true })
    .click();
  const link = await page
    .getByLabel('Save this link now', { exact: true })
    .inputValue();

  // A public responder: no session, only the link.
  const outsider = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  try {
    await respond(await outsider.newPage(), 'Corner shop', link);
  } finally {
    await outsider.close();
  }
  const publicRun = await completeRequest(page, workspaceId);
  await capture(page, 'request');
  await page
    .getByRole('button', { name: 'Send response', exact: true })
    .click();
  const answered = page.getByRole('region', { name: 'Uploaded files' });
  await expect(
    answered.getByRole('button', {
      name: 'Download signed-note.pdf',
      exact: true,
    }),
  ).toBeVisible();
  await capture(page, 'request-answered');
  const run = await waitForRun(page, workspaceId, publicRun, 'succeeded');
  const read = run.nodes.find((node) => node.nodeId === 'read');
  if (read === undefined) throw new Error('Read file did not run');
  const output = await page.request.get(
    `/v1/workspaces/${workspaceId}/runs/${publicRun}/node-runs/${read.id}/output`,
  );
  expect(await output.json()).toMatchObject({
    output: {
      kind: 'inline',
      value: [
        { sku: 'A-1', qty: 2 },
        { sku: 'B-2', qty: 5 },
      ],
    },
  });
  await page.goto(`/w/${workspaceId}/runs/${publicRun}`);
  await page.getByRole('tab', { name: 'Input & output', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Uploaded files' })
      .getByRole('button', { name: 'Download orders.csv', exact: true }),
  ).toBeVisible();
  await capture(page, 'run-input');

  // A member responds through the workspace form.
  await respond(page, 'Main street', `/w/${workspaceId}/forms/${workflowId}`);
  const memberRun = await completeRequest(page, workspaceId);
  await page
    .getByRole('button', { name: 'Send response', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Form owner sent this response',
      exact: true,
    }),
  ).toBeVisible();
  await waitForRun(page, workspaceId, memberRun, 'succeeded');
});
