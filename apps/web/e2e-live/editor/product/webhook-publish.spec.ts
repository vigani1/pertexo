import type { Page } from '@playwright/test';
import {
  webhookTriggerListResponseSchema,
  workflowRunListResponseSchema,
  workflowVersionsResponseSchema,
} from '@pertexo/contracts';
import { test } from '../../support/browser-fixture';
import { createEditorWorkflow } from '../../support/authoring/single-step';
import {
  createEditorWorkspace,
  registerEditorUser,
} from '../../support/ordinary-editor-session';
import {
  expect,
  addStep,
  publishNext,
  removeStep,
  runReaches,
  sendSigned,
  setLiteralInput,
} from './steps';

// Several real services behind one browser; this stays honest on a busy machine.
test.describe.configure({ timeout: 120_000 });

const STEP = 'Incoming order';

function acceptedRun(body: unknown) {
  return (body as { runId: string }).runId;
}

/** A published webhook then a Set fields step, with an endpoint just created in Triggers. */
async function publishedWebhook(
  page: Page,
  request: Parameters<typeof registerEditorUser>[1],
) {
  const mail = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mail === undefined) throw new Error('Use the owned API fixture');
  await registerEditorUser(page, request, mail, 'Live webhook owner');
  const workspaceId = await createEditorWorkspace(page, 'Live webhooks');
  const path = await createEditorWorkflow(page, workspaceId, 'Order intake');
  const editorUrl = new URL(page.url()).pathname;
  const workflowId = path.split('/').at(-1);
  if (workflowId === undefined) throw new Error('Workflow missing');
  const webhookId = await addStep(page, path, /^Webhook\b/u, STEP);
  const applyId = await addStep(page, path, /^Set fields\b/u, 'Apply order');
  await setLiteralInput(page, path, {
    nodeId: applyId,
    field: 'batch',
    value: 1,
  });
  await publishNext(page, 1, 'needs-webhook-address');
  await expect
    .poll(async () => {
      const response = await page.request.get(`${path}/triggers`);
      return webhookTriggerListResponseSchema.parse(await response.json())
        .items[0]?.status;
    })
    .toBe('configuration_required');
  await page.goto(`${editorUrl}/triggers`);
  await page
    .getByRole('article', { name: `Webhook: ${STEP}`, exact: true })
    .getByRole('button', { name: 'Create endpoint', exact: true })
    .click();
  const reveal = page.getByRole('dialog', {
    name: 'Store these now',
    exact: true,
  });
  await expect(reveal).toBeVisible();
  const codes = await reveal.locator('code').allTextContents();
  const keys = codes.filter((code) => /^[\w-]{43}$/u.test(code));
  const endpointKey = keys[0];
  const secret = keys.at(-1);
  if (endpointKey === undefined || secret === undefined)
    throw new Error('Transient credentials missing');
  return {
    workspaceId,
    workflowId,
    path,
    editorUrl,
    webhookId,
    applyId,
    endpointKey,
    secret,
    reveal,
  };
}

async function closeReveal(page: Page) {
  const reveal = page.getByRole('dialog', {
    name: 'Store these now',
    exact: true,
  });
  await reveal.getByRole('switch', { name: 'I’ve stored these' }).click();
  await reveal.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(reveal).toBeHidden();
}

test('a publish keeps a live webhook answering on the new version, with its history', async ({
  page,
  request,
}) => {
  const origin = process.env.PERTEXO_API_PROXY_TARGET;
  if (origin === undefined) throw new Error('Use the owned API fixture');
  const live = await publishedWebhook(page, request);
  await closeReveal(page);
  const hookUrl = new URL(`/hooks/${live.endpointKey}`, origin).toString();

  const first = await sendSigned(hookUrl, live.secret);
  expect(first.status).toBe(202);
  const firstRun = acceptedRun(await first.json());
  await runReaches(page, live.workspaceId, firstRun, 'succeeded');

  await page.goto(live.editorUrl);
  await page.getByTestId(`rf__node-${live.applyId}`).focus();
  await page.keyboard.press('Enter');
  await setLiteralInput(page, live.path, {
    nodeId: live.applyId,
    field: 'revision',
    value: 2,
  });
  const dialogText = await publishNext(page, 2);
  expect(dialogText).not.toMatch(/stops? answering|retire|no longer/iu);

  const versions = workflowVersionsResponseSchema.parse(
    await (await page.request.get(`${live.path}/versions`)).json(),
  ).items;
  const v2 = versions.find(({ versionNumber }) => versionNumber === 2);
  if (v2 === undefined) throw new Error('v2 missing');

  // Immediately after, and once the worker has reconciled it.
  const immediately = await sendSigned(hookUrl, live.secret);
  expect(immediately.status).toBe(202);
  await expect
    .poll(async () => {
      const page1 = await page.request.get(
        `/v1/workspaces/${live.workspaceId}/runs?workflowId=${live.workflowId}&limit=10`,
      );
      return workflowRunListResponseSchema
        .parse(await page1.json())
        .items.filter((run) => run.status === 'succeeded').length;
    })
    .toBe(2);
  const settled = await sendSigned(hookUrl, live.secret);
  expect(settled.status).toBe(202);
  const onV2 = acceptedRun(await settled.json());
  const done = await runReaches(page, live.workspaceId, onV2, 'succeeded');
  expect(done.run.workflowVersionId).toBe(v2.id);

  await page.goto(`${live.editorUrl}/triggers`);
  const card = page.getByRole('article', {
    name: `Webhook: ${STEP}`,
    exact: true,
  });
  await expect(
    card.getByRole('button', { name: 'Create endpoint', exact: true }),
  ).toBeHidden();
  await expect(page.getByText('Nothing has arrived')).toBeHidden();
  await expect(page.getByText(/Trigger needs setup/u)).toBeHidden();
  // Three deliveries, including the one from before the publish.
  await expect(
    card.getByRole('listitem').filter({ hasText: /Accepted/u }),
  ).toHaveCount(3);
});

test('the publish dialog warns when a webhook step goes, and the endpoint then retires', async ({
  page,
  request,
}) => {
  const origin = process.env.PERTEXO_API_PROXY_TARGET;
  if (origin === undefined) throw new Error('Use the owned API fixture');
  const live = await publishedWebhook(page, request);
  await closeReveal(page);
  const hookUrl = new URL(`/hooks/${live.endpointKey}`, origin).toString();
  expect((await sendSigned(hookUrl, live.secret)).status).toBe(202);

  await page.goto(live.editorUrl);
  await removeStep(page, live.path, live.webhookId);
  await addStep(page, live.path, /^Manual\b/u, 'Start by hand');
  const dialogText = await publishNext(page, 2);
  // The change list also names the step, so the warning must share its line.
  expect(
    dialogText
      .split('\n')
      .some(
        (line) => line.includes(STEP) && /stop|retire|no longer/iu.test(line),
      ),
  ).toBe(true);

  await expect
    .poll(async () => (await sendSigned(hookUrl, live.secret)).status)
    .toBe(401);
});

test('the reveal dialog gives a whole address that really takes a delivery', async ({
  page,
  request,
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const live = await publishedWebhook(page, request);
  const pageOrigin = new URL(page.url()).origin;
  const address = `${pageOrigin}/hooks/${live.endpointKey}`;
  await expect(live.reveal).toContainText(address);
  await expect(live.reveal).not.toContainText('your Pertexo API address');
  await live.reveal
    .getByRole('button', { name: /copy (the )?(webhook )?(url|address)/iu })
    .click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(address);
  expect((await sendSigned(copied, live.secret)).status).toBe(202);
});
