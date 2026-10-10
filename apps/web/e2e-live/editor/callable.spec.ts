import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import {
  apiProblemSchema,
  workflowPublishResponseSchema,
  workflowRunStartResponseSchema,
  workflowValidateResponseSchema,
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

async function csrf(page: Page) {
  const cookie = (await page.context().cookies()).find(
    (item) => item.name === 'pertexo_csrf',
  );
  if (cookie === undefined) throw new Error('Ordinary CSRF cookie missing');
  return { 'x-csrf-token': decodeURIComponent(cookie.value) };
}

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
  await expect(contract).toBeFocused();
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, path)).graph.callable?.resultType.type,
    )
    .toBe('string');
  await page.setViewportSize({ width: 1280, height: 900 });
  const published = await publishSingleStep(page, path);
  const headers = await csrf(page);
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
