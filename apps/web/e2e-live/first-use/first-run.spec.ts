import {
  workflowListResponseSchema,
  workflowRunResponseSchema,
} from '@pertexo/contracts';
import { test } from '../support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from '../support/ordinary-editor-session';
import { expect, publishNext } from '../editor/product/steps';

test.describe.configure({ timeout: 120_000 });

test('a new workspace runs its example by following the guide', async ({
  page,
  request,
}) => {
  const mail = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mail === undefined) throw new Error('Use the owned API fixture');
  await registerEditorUser(page, request, mail, 'First run owner');
  const workspaceId = await createEditorWorkspace(page, 'First run');
  await page.goto(`/w/${workspaceId}`);
  // A double click on the offer still makes one example.
  await page
    .getByRole('region', { name: 'Getting started' })
    .getByRole('button', { name: 'Try the example', exact: true })
    .dblclick();
  await expect(page).toHaveURL(
    new RegExp(
      `/w/${workspaceId}/workflows/[0-9a-f-]{36}\\?guide=first-run$`,
      'u',
    ),
  );
  const guide = page.getByRole('region', { name: 'Your first run' });
  await expect(guide).toBeVisible();

  await publishNext(page, 1);
  await expect(
    guide.getByRole('listitem').filter({ hasText: 'Publish it' }),
  ).toContainText('Done');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Run published version', exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/w/${workspaceId}/runs/[0-9a-f-]{36}$`, 'u'),
  );
  const runId = new URL(page.url()).pathname.split('/')[4];
  if (runId === undefined) throw new Error('Run URL has no identifier');
  // The run opens on its timeline, and finishes there.
  await expect(
    page.getByRole('tab', { name: /^Timeline/u, selected: true }),
  ).toBeVisible();
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/v1/workspaces/${workspaceId}/runs/${runId}`,
        );
        return workflowRunResponseSchema.parse(await response.json()).run
          .status;
      },
      { timeout: 60_000 },
    )
    .toBe('succeeded');
  await expect(
    page.getByText('Succeeded', { exact: true }).first(),
  ).toBeVisible();

  const listed = await page.request.get(
    `/v1/workspaces/${workspaceId}/workflows`,
  );
  expect(listed.status()).toBe(200);
  expect(
    workflowListResponseSchema.parse(await listed.json()).items,
  ).toHaveLength(1);
});
