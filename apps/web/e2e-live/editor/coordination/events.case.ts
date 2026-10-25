import {
  webhookIngressResponseSchema,
  webhookTriggerListResponseSchema,
  workflowRunListResponseSchema,
} from '@pertexo/contracts';
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readCsrfToken } from '../../../test/support/browser/csrf';
import {
  createEditorWorkflow,
  publishSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';
import { test } from '../../support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from '../../support/ordinary-editor-session';
import { configure, save, send } from './event-delivery';
test('coordinates all three real signed webhook policies with visible history', async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  const mail = process.env.PERTEXO_LIVE_MAIL_ORIGIN,
    origin = process.env.PERTEXO_API_PROXY_TARGET;
  if (mail === undefined || origin === undefined)
    throw new Error('Owned fixture required');
  await registerEditorUser(page, request, mail, 'Coordination owner');
  const workspaceId = await createEditorWorkspace(
    page,
    'Coordination qualification',
  );
  for (const mode of ['deduplicate', 'debounce', 'throttle'] as const) {
    const path = await createEditorWorkflow(
      page,
      workspaceId,
      `Coordinated ${mode}`,
    );
    const workflowId = path.split('/').at(-1);
    if (workflowId === undefined) throw new Error('Missing workflow');
    const editorUrl = new URL(page.url()).pathname;
    await save(page, path, 'core.webhook');
    await configure(page, path, mode);
    await page.setViewportSize({ width: 375, height: 768 });
    await page
      .getByRole('navigation', { name: 'Editor panels' })
      .getByRole('button', { name: 'Step', exact: true })
      .click();
    await page.getByLabel('Policy', { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByLabel('Policy', { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/pertexo-f25-${mode}-phone.png`,
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await publishSingleStep(page, path);
    await expect
      .poll(async () => {
        const response = await page.request.get(`${path}/triggers`);
        return webhookTriggerListResponseSchema.parse(await response.json())
          .items[0]?.status;
      })
      .toBe('configuration_required');
    await page.goto(`${editorUrl}/triggers`);
    await page
      .getByRole('button', { name: 'Create endpoint', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Store these now',
      exact: true,
    });
    await expect(dialog).toBeVisible();
    const codes = await dialog.locator('code').allTextContents();
    const endpoint = codes[0],
      secret = codes.at(-1);
    if (endpoint === undefined || secret === undefined)
      throw new Error('Reveal missing');
    await dialog.getByRole('switch', { name: 'I’ve stored these' }).click();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    const key = randomUUID(),
      payload = { orderId: 'order-42', message: 'first' };
    const first = await send({ origin, endpoint, secret, key, payload });
    expect(first.status).toBe(202);
    const replay = await send({ origin, endpoint, secret, key, payload });
    expect(replay.status).toBe(202);
    const receipt = webhookIngressResponseSchema.parse(first.body);
    expect(replay.body).toEqual(
      'runId' in receipt ? { ...receipt, replayed: true } : receipt,
    );
    const next = await send({
      origin,
      endpoint,
      secret,
      key: randomUUID(),
      payload: {
        ...payload,
        message: 'latest',
      },
    });
    expect(next.status).toBe(202);
    expect(next.body).toMatchObject({
      coordinated: true,
      outcome: {
        deduplicate: 'deduplicated',
        debounce: 'debounced',
        throttle: 'throttled',
      }[mode],
    });
    const read = async () => {
      const result = await page.request.get(
        `/v1/workspaces/${workspaceId}/runs?workflowId=${workflowId}&limit=10`,
      );
      expect(result.status()).toBe(200);
      return workflowRunListResponseSchema.parse(await result.json());
    };
    const expected = mode === 'throttle' ? 2 : 1;
    await expect
      .poll(async () => (await read()).items.length, { timeout: 20000 })
      .toBe(expected);
    for (const run of (await read()).items)
      await waitForRun(page, workspaceId, run.id, 'succeeded');
    await page.reload();
    await expect(
      page
        .getByText(
          mode === 'debounce' ? 'Replaced by a newer event' : 'Started',
          { exact: true },
        )
        .first(),
    ).toBeVisible();
    await page.screenshot({
      path: `/tmp/pertexo-f25-${mode}-history.png`,
      animations: 'disabled',
    });
    await page.goto(`/w/${workspaceId}/settings/usage?window=24h`);
    await expect(
      page.getByText(
        new RegExp(
          `${{ deduplicate: '2', debounce: '4', throttle: '6' }[mode]} events matched up by trigger coordination`,
          'u',
        ),
      ),
    ).toBeVisible();
  }
});

test('a public coordinated form shows pending without redirect and editor history follows the admitted run', async ({
  page,
  request,
}) => {
  const mail = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mail === undefined) throw new Error('Owned fixture required');
  await registerEditorUser(page, request, mail, 'Coordinated form owner');
  const workspaceId = await createEditorWorkspace(page, 'Coordinated forms');
  const path = await createEditorWorkflow(
    page,
    workspaceId,
    'Coordinated form',
  );
  const editorUrl = new URL(page.url()).pathname;
  await save(page, path, 'core.form');
  await configure(page, path, 'debounce', true);
  await publishSingleStep(page, path);
  const capability = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString('base64url');
  const result = await page.request.post(`${path}/form/access`, {
    headers: {
      'x-csrf-token': await readCsrfToken(page),
      'Idempotency-Key': randomUUID(),
    },
    data: { access: 'public', capability, expectedRevision: 0 },
  });
  expect(result.status()).toBe(200);
  const access = (await result.json()) as { publicId: string };
  await page.setViewportSize({ width: 375, height: 768 });
  await page.goto(`/forms/${access.publicId}#${capability}`);
  await page.getByLabel('Order', { exact: true }).fill('order-42');
  await page.getByLabel('Message', { exact: true }).fill('Safe pending input');
  await page
    .getByRole('button', { name: 'Send response', exact: true })
    .click();
  await expect(page.getByText('Pending', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Accepted for later. No run has started yet.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: '/tmp/pertexo-f25-form-phone.png',
    animations: 'disabled',
  });
  await expect
    .poll(
      async () => {
        const r = await page.request.get(`${path}/form/events`);
        expect(r.status()).toBe(200);
        const data = (await r.json()) as { items: { status: string }[] };
        return data.items[0]?.status;
      },
      { timeout: 20000 },
    )
    .toBe('started');
  await page.goto(editorUrl);
  await page.getByTestId('rf__node-entry').focus();
  await page.keyboard.press('Enter');
  await page
    .getByRole('navigation', { name: 'Editor panels' })
    .getByRole('button', { name: 'Step', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Coordinated form events', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Started', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .getByRole('heading', { name: 'Coordinated form events', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: '/tmp/pertexo-f25-form-history.png',
    animations: 'disabled',
  });
});
