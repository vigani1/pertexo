import { mkdir } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { workflowTestAcceptedSchema } from '@pertexo/contracts';
import { test } from '../../support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from '../../support/ordinary-editor-session';
import {
  addSingleStep,
  createEditorWorkflow,
  readEditorDraft,
  waitForRun,
} from '../../support/authoring/single-step';

test('callback Wait is authored in the editor and resumes a whole-draft test through real ingress', async ({
  page,
  request,
}) => {
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Use the owned API fixture');
  await registerEditorUser(page, request, mailOrigin, 'Callback owner');
  const workspaceId = await createEditorWorkspace(
    page,
    'Callback qualification',
  );
  const path = await createEditorWorkflow(
    page,
    workspaceId,
    'Callback qualification',
  );
  const waitId = await addSingleStep(
    page,
    path,
    /^Wait /u,
    'Wait for callback',
  );
  await page.getByRole('combobox', { name: 'Wait until', exact: true }).click();
  await page.getByRole('option', { name: 'Called back', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, path)).graph.nodes[0]?.config.mode,
    )
    .toBe('callback');
  await expect(page.getByTestId(`rf__node-${waitId}`)).toContainText(
    'Until called back',
  );
  await mkdir('/tmp/pertexo-f46-browser', { recursive: true });
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    for (const width of [1440, 990, 375]) {
      await page.setViewportSize({ width, height: 900 });
      if (width < 1024) {
        const panel = page.getByRole('button', { name: 'Step', exact: true });
        if ((await panel.getAttribute('aria-pressed')) !== 'true')
          await panel.click();
      }
      await expect(
        page.getByRole('combobox', { name: 'Wait until', exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: `/tmp/pertexo-f46-browser/wait-${colorScheme}-${String(width)}.png`,
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const acceptedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`${path}/draft/tests`) &&
      response.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: 'Test workflow', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Test workflow',
    exact: true,
  });
  await dialog.getByLabel('Test input (JSON)', { exact: true }).fill('{}');
  await dialog.getByRole('button', { name: 'Start test', exact: true }).click();
  const accepted = await acceptedResponse;
  expect(accepted.status()).toBe(202);
  const { runId } = workflowTestAcceptedSchema.parse(await accepted.json());
  await waitForRun(page, workspaceId, runId, 'waiting');
  await expect(
    page.getByRole('region', { name: 'Workflow tests' }),
  ).toContainText('Waiting');
  const posted = await request.post(`${mailOrigin}/callback-resume`, {
    data: { workspaceId, runId },
  });
  expect(posted.status()).toBe(204);
  await waitForRun(page, workspaceId, runId, 'succeeded');
  await expect(
    page.getByRole('region', { name: 'Workflow tests' }),
  ).toContainText('Succeeded');
});
