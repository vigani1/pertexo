import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import {
  formConfigSchema,
  inputRequestConfigSchema,
} from '@pertexo/workflow-model';
import { pendingTaskListResponseSchema } from '@pertexo/contracts';
import { test } from '../../support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
} from '../../support/ordinary-editor-session';
import {
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
  waitForRun,
} from '../../support/authoring/single-step';
async function csrf(page: Page) {
  const cookie = (await page.context().cookies()).find(
    (value) => value.name === 'pertexo_csrf',
  );
  if (cookie === undefined) throw new Error('CSRF missing');
  return decodeURIComponent(cookie.value);
}
const node = (id: string, key: string, x: number) => ({
  id,
  definition: { key, version: 1 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
  position: { x, y: 0 },
});
const edge = (source: string, target: string) => ({
  id: `${source}-${target}`,
  source: { nodeId: source, port: 'out' },
  target: { nodeId: target, port: 'in' },
});
test('published member and public forms start real runs; captured member input continues once, with revocable links', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(120000);
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Owned mail missing');
  await registerEditorUser(page, request, mailOrigin, 'Form owner');
  const workspaceId = await createEditorWorkspace(page, 'Form qualification');
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Collect a request',
  );
  const workflowId = workflowPath.split('/').at(-1);
  if (workflowId === undefined) throw new Error('Workflow missing');
  const form = formConfigSchema.parse({
    title: 'Send a request',
    instructions: 'Tell us what you need.',
    fields: [
      { id: 'message', name: 'message', label: 'Message', type: 'textarea' },
      { id: 'amount', name: 'amount', label: 'Amount', type: 'number' },
    ],
  });
  const graph = {
    settings: { maxRunDurationMs: 60000 },
    nodes: [
      { ...node('form', 'core.form', 0), config: form },
      {
        ...node('input', 'core.request_input', 260),
        config: inputRequestConfigSchema.parse({
          title: 'Complete the request',
          fields: [
            { id: 'answer', name: 'answer', label: 'Answer', type: 'text' },
          ],
        }),
        inputMappings: {
          details: { kind: 'node_output', nodeId: 'form', path: '$.values' },
          prefill: {
            kind: 'expression',
            language: 'jsonata',
            expression: '{"answer": nodeOutputs.form.values.request_message}',
          },
        },
      },
      {
        ...node('finish', 'core.terminate', 520),
        inputMappings: {
          result: {
            kind: 'node_output',
            nodeId: 'input',
            path: '$.values.answer',
          },
        },
      },
    ],
    edges: [edge('form', 'input'), edge('input', 'finish')],
  };
  const draft = await page.request.get(`${workflowPath}/draft`);
  const saved = await page.request.put(`${workflowPath}/draft`, {
    headers: {
      'If-Match': draft.headers().etag ?? '',
      'x-csrf-token': await csrf(page),
    },
    data: { graph },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  await page.reload();
  await page.getByTestId('rf__node-form').focus();
  await page.keyboard.press('Enter');
  const first = page.getByRole('region', { name: 'Field 1', exact: true });
  await expect(first).toBeVisible({ timeout: 5000 });
  const name = first.getByLabel('Data name', { exact: true });
  await name.fill('request_message');
  await expect(name).toBeFocused();
  await page.keyboard.press('Tab');
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes[0]?.config
          .fields,
    )
    .toMatchObject([{ name: 'request_message' }, { name: 'amount' }]);
  await page
    .getByRole('button', { name: 'Move field 1 down', exact: true })
    .click();
  await expect
    .poll(async () => {
      const fields = (await readEditorDraft(page, workflowPath)).graph.nodes[0]
        ?.config.fields;
      return Array.isArray(fields) ? (fields[0] as unknown) : null;
    })
    .toMatchObject({ name: 'amount' });
  const version = await publishSingleStep(page, workflowPath);
  // Manual start cannot forge server-owned Form metadata.
  const manual = await page.request.post(`${workflowPath}/runs`, {
    headers: {
      'x-csrf-token': await csrf(page),
      'Idempotency-Key': randomUUID(),
    },
    data: {
      expectedPublishedVersionId: version.id,
      input: {
        values: { amount: 1 },
        submittedBy: null,
        submittedAt: '2026-01-01',
      },
    },
  });
  expect(manual.status()).toBe(409);
  const noCsrf = await page.request.post(`${workflowPath}/form/submit`, {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      versionId: version.id,
      values: { amount: 0, request_message: 'Refused' },
    },
  });
  expect(noCsrf.status()).toBe(403);
  const invalid = await page.request.post(`${workflowPath}/form/submit`, {
    headers: {
      'Idempotency-Key': randomUUID(),
      'x-csrf-token': await csrf(page),
    },
    data: {
      versionId: version.id,
      values: { amount: 'invalid', request_message: 'Refused' },
    },
  });
  expect(invalid.status()).toBe(400);
  expect(((await invalid.json()) as { code: string }).code).toBe(
    'form.invalid',
  );

  await page
    .getByRole('button', { name: 'Enable public link', exact: true })
    .click();
  const link = await page
    .getByLabel('Save this link now', { exact: true })
    .inputValue();
  expect(link).toContain('/forms/');
  const publicContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  const publicPage = await publicContext.newPage();
  try {
    await mkdir('/tmp/pertexo-form-screenshots', { recursive: true });
    for (const [kind, width] of [
      ['member', 1280],
      ['public', 375],
    ] as const) {
      const responder = kind === 'member' ? page : publicPage;
      await responder.setViewportSize({ width, height: 768 });
      await responder.emulateMedia({ reducedMotion: 'reduce' });
      await responder.goto(
        kind === 'public' ? link : `/w/${workspaceId}/forms/${workflowId}`,
      );
      await expect(
        responder.getByRole('heading', { name: 'Send a request', exact: true }),
      ).toBeVisible();
      expect(
        await responder.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await responder
        .getByRole('button', { name: 'Send response', exact: true })
        .click();
      await expect(
        responder
          .getByText('Enter a valid value for this field.', { exact: true })
          .first(),
      ).toBeVisible();
      await responder
        .getByLabel('Message', { exact: true })
        .fill(`${kind} request`);
      await responder.getByLabel('Amount', { exact: true }).fill('0');
      await responder.screenshot({
        path: `/tmp/pertexo-form-screenshots/${kind}-${String(width)}-before.png`,
        fullPage: true,
      });
      const submit = responder.waitForResponse(
        (response) =>
          (response.request().method() === 'POST' &&
            response.url().endsWith('/form/submit')) ||
          (response.request().method() === 'POST' &&
            /\/v1\/forms\/[^/]+\/submit$/u.test(response.url())),
      );
      await responder
        .getByRole('button', { name: 'Send response', exact: true })
        .click();
      const receipt = await submit;
      expect(receipt.status(), await receipt.text()).toBe(200);
      const accepted = (await receipt.json()) as Record<string, unknown>;
      await expect(
        responder.getByRole('heading', { name: 'Response sent', exact: true }),
      ).toBeVisible();
      if (kind === 'public') {
        expect(accepted).toEqual({ accepted: true, replayed: false });
        await expect(
          responder.getByRole('link', { name: 'Open run', exact: true }),
        ).toHaveCount(0);
      }
      await responder.screenshot({
        path: `/tmp/pertexo-form-screenshots/${kind}-${String(width)}-after.png`,
        fullPage: true,
      });
      let runId = '';
      await expect
        .poll(async () => {
          const response = await page.request.get(
            `/v1/workspaces/${workspaceId}/pending-tasks?view=all&status=pending&kind=input_request`,
          );
          const tasks = pendingTaskListResponseSchema.parse(
            await response.json(),
          );
          runId = tasks.items[0]?.runId ?? '';
          return tasks.items.length;
        })
        .toBe(1);
      await page.setViewportSize({ width, height: 768 });
      await page.goto(`/w/${workspaceId}/inbox`);
      const requests = page.getByRole('region', {
        name: 'Requests',
        exact: true,
      });
      await expect(
        requests.getByRole('link', {
          name: 'Complete the request',
          exact: true,
        }),
      ).toBeVisible({ timeout: 5000 });
      await expect(
        requests.getByText(`${kind} request`, { exact: true }),
      ).toBeVisible();
      await requests
        .getByRole('link', { name: 'Complete the request', exact: true })
        .click();
      await expect(page.getByLabel('Answer', { exact: true })).toHaveValue(
        `${kind} request`,
      );
      await page.screenshot({
        path: `/tmp/pertexo-form-screenshots/${kind}-${String(width)}-request-context.png`,
        fullPage: true,
      });
      await page.getByLabel('Answer', { exact: true }).fill(`${kind} answer`);
      await page
        .getByRole('button', { name: 'Send response', exact: true })
        .focus();
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('heading', {
          name: 'Form owner sent this response',
          exact: true,
        }),
      ).toBeVisible();
      await waitForRun(page, workspaceId, runId, 'succeeded');
      await page.goto(`/w/${workspaceId}/runs/${runId}`);
      await page.getByRole('button', { name: 'Replay', exact: true }).click();
      const replay = page.getByRole('dialog', {
        name: 'Replay this run',
        exact: true,
      });
      await expect(
        replay.getByLabel('Replay input (JSON)', { exact: true }),
      ).toHaveAttribute('readonly');
      await expect(
        replay.getByRole('link', { name: 'Open workflow form', exact: true }),
      ).toBeVisible();
      await replay.getByRole('button', { name: 'Cancel', exact: true }).click();
    }
    await page.setViewportSize({ width: 1280, height: 768 });
    await page.goto(`/w/${workspaceId}/workflows/${workflowId}`);
    await page.getByTestId('rf__node-form').focus();
    await page.keyboard.press('Enter');
    await page
      .getByRole('button', { name: 'Regenerate link', exact: true })
      .click();
    await expect(
      page.getByLabel('Save this link now', { exact: true }),
    ).not.toHaveValue(link);
    await publicPage.goto(link);
    await publicPage.reload();
    await expect(
      publicPage.getByText('This form is not available.', { exact: false }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Turn public access off', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Enable public link', exact: true }),
    ).toBeVisible();
  } finally {
    await publicContext.close();
  }
});
