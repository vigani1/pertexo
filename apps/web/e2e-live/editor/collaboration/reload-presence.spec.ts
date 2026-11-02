import { expect, type Request } from '@playwright/test';
import { COLLABORATION_LIMITS } from '@pertexo/workflow-model';
import { test } from '../../support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
} from '../../support/ordinary-editor-session';
import {
  createEditorWorkflow,
  addSingleStep,
} from '../../support/authoring/single-step';

const ANOTHER_TAB = 'Also in another tab';
const UNSAVED = 'Unsaved changes in another tab.';
// A first read can race the old page's leave; the next heartbeat reads again. The
// old lease would last far longer than this, so waiting can't hide a lost leave.
const SETTLED = { timeout: COLLABORATION_LIMITS.heartbeatMs + 5_000 };

test("a reload is not another tab, while a real other tab and a reloaded tab's unsaved work still warn", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Owned mail missing');
  await registerEditorUser(page, request, mailOrigin, 'Presence owner');
  const workspaceId = await createEditorWorkspace(page, 'Presence reload');
  const path = await createEditorWorkflow(page, workspaceId, 'One tab');
  const workflowId = path.split('/').at(-1);
  if (workflowId === undefined) throw new Error('Workflow missing');
  const nodeId = await addSingleStep(page, path, /^Manual/u, 'Shared input');
  const editor = `/w/${workspaceId}/workflows/${workflowId}`;

  await page.goto(editor);
  await page.getByTestId('rf__node-' + nodeId).waitFor();
  await page.reload();
  await page.getByTestId('rf__node-' + nodeId).waitFor();
  await expect(page.getByText(ANOTHER_TAB, { exact: true })).toHaveCount(
    0,
    SETTLED,
  );

  const other = await page.context().newPage();
  await other.goto(editor);
  await expect(other.getByText(ANOTHER_TAB, { exact: true })).toBeVisible(
    SETTLED,
  );
  await expect(page.getByText(ANOTHER_TAB, { exact: true })).toBeVisible(
    SETTLED,
  );

  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route('**/draft', async (route) => {
    if (route.request().method() === 'PUT') {
      held = true;
      await barrier;
    }
    await route.continue();
  });
  try {
    await page.getByTestId('rf__node-' + nodeId).focus();
    await page.keyboard.press('Enter');
    await page.getByLabel('Label', { exact: true }).fill('Unfinished');
    await expect.poll(() => held).toBe(true);
    await expect(other.getByText(UNSAVED, { exact: true })).toBeVisible(
      SETTLED,
    );
  } finally {
    release();
  }
  await expect(page.getByRole('status').getByText('Saved')).toBeVisible();
  await other.close();
});

test('a leave that comes late, or never, only reads as another tab until the next read or the lease', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Owned mail missing');
  await registerEditorUser(page, request, mailOrigin, 'Presence leave');
  const workspaceId = await createEditorWorkspace(page, 'Presence leave');
  const path = await createEditorWorkflow(page, workspaceId, 'Lost leave');
  const workflowId = path.split('/').at(-1);
  if (workflowId === undefined) throw new Error('Workflow missing');
  const nodeId = await addSingleStep(page, path, /^Manual/u, 'Shared input');
  const editor = `/w/${workspaceId}/workflows/${workflowId}`;
  // This page never sends its leave, as when that request is lost. It has to be
  // registered first: a route can't hold a request made while the page goes.
  await page.addInitScript(() => {
    window.addEventListener(
      'pagehide',
      (event) => {
        event.stopImmediatePropagation();
      },
      { capture: true },
    );
  });
  const heartbeats: Request[] = [];
  page.on('request', (sent) => {
    if (sent.method() === 'PUT' && sent.url().includes('/presence/'))
      heartbeats.push(sent);
  });
  await page.goto(editor);
  await page.getByTestId('rf__node-' + nodeId).waitFor();
  await expect.poll(() => heartbeats.length, SETTLED).toBeGreaterThan(0);
  const lease = heartbeats.at(-1);
  if (lease === undefined) throw new Error('No heartbeat was sent');
  const {
    'content-length': _length,
    'content-type': _type,
    ...headers
  } = await lease.allHeaders();

  // The race a first read can lose: the page is back before its old lease has gone.
  await page.reload();
  await page.getByTestId('rf__node-' + nodeId).waitFor();
  await expect(page.getByText(ANOTHER_TAB, { exact: true })).toBeVisible(
    SETTLED,
  );
  const left = await page.request.delete(lease.url(), { headers });
  expect(left.status()).toBe(204);
  await expect(page.getByText(ANOTHER_TAB, { exact: true })).toHaveCount(
    0,
    SETTLED,
  );

  // The leave lost for good: the old lease runs out on its own.
  await page.reload();
  await page.getByTestId('rf__node-' + nodeId).waitFor();
  await expect(page.getByText(ANOTHER_TAB, { exact: true })).toBeVisible(
    SETTLED,
  );
  await expect(page.getByText(ANOTHER_TAB, { exact: true })).toHaveCount(0, {
    timeout:
      COLLABORATION_LIMITS.leaseSeconds * 1_000 +
      COLLABORATION_LIMITS.heartbeatMs +
      5_000,
  });
});
