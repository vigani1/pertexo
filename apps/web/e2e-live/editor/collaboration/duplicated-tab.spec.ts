import { expect } from '@playwright/test';
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
const SETTLED = { timeout: COLLABORATION_LIMITS.heartbeatMs + 5_000 };

test("a duplicated tab is another tab: each warns about the other's unsaved work", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Owned mail missing');
  await registerEditorUser(page, request, mailOrigin, 'Presence owner');
  const workspaceId = await createEditorWorkspace(page, 'Presence duplicate');
  const path = await createEditorWorkflow(page, workspaceId, 'Two tabs');
  const workflowId = path.split('/').at(-1);
  if (workflowId === undefined) throw new Error('Workflow missing');
  const nodeId = await addSingleStep(page, path, /^Manual/u, 'Shared input');
  const editor = `/w/${workspaceId}/workflows/${workflowId}`;
  await page.goto(editor);
  await page.getByTestId('rf__node-' + nodeId).waitFor();

  // `context.newPage` can't copy sessionStorage. A tab opened from a page does,
  // which is what makes this the same as the browser's Duplicate tab.
  await page.evaluate(() => {
    sessionStorage.setItem('duplicate-proof', 'copied');
  });
  const [duplicate] = await Promise.all([
    page.context().waitForEvent('page'),
    page.evaluate((url) => {
      window.open(url);
    }, editor),
  ]);
  duplicate.setDefaultTimeout(15_000);
  await duplicate.getByTestId('rf__node-' + nodeId).waitFor();
  expect(
    await duplicate.evaluate(() => sessionStorage.getItem('duplicate-proof')),
  ).toBe('copied');

  await expect(duplicate.getByText(ANOTHER_TAB, { exact: true })).toBeVisible(
    SETTLED,
  );
  await expect(page.getByText(ANOTHER_TAB, { exact: true })).toBeVisible(
    SETTLED,
  );

  /** Leaves `writer` with an edit it can't save yet, and `reader` warned of it. */
  async function warns(
    writer: typeof page,
    reader: typeof page,
    label: string,
  ) {
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await writer.route('**/draft', async (route) => {
      if (route.request().method() === 'PUT') {
        held = true;
        await barrier;
      }
      await route.continue();
    });
    try {
      await writer.getByTestId('rf__node-' + nodeId).focus();
      await writer.keyboard.press('Enter');
      await writer.getByLabel('Label', { exact: true }).fill(label);
      await expect.poll(() => held).toBe(true);
      await expect(reader.getByText(UNSAVED, { exact: true })).toBeVisible(
        SETTLED,
      );
    } finally {
      release();
    }
    await expect(writer.getByRole('status').getByText('Saved')).toBeVisible();
    await writer.unrouteAll({ behavior: 'wait' });
    await expect(reader.getByText(UNSAVED, { exact: true })).toHaveCount(
      0,
      SETTLED,
    );
  }

  await warns(duplicate, page, 'From the duplicate');
  // Takes the duplicate's save, so that the reverse has no conflict to answer.
  await page.reload();
  await page.getByTestId('rf__node-' + nodeId).waitFor();
  await warns(page, duplicate, 'From the original');
  await duplicate.close();
});
