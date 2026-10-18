import { mkdir } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from '../../support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
} from '../../support/ordinary-editor-session';
import {
  createEditorWorkflow,
  addSingleStep,
  publishSingleStep,
  startSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';
test('reviews and runs independent promoted workflows at desktop and phone widths', async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Owned mail missing');
  await registerEditorUser(page, request, mailOrigin, 'Promotion owner');
  const sourceId = await createEditorWorkspace(page, 'Promotion development');
  await page.goto('/workspaces');
  await page
    .getByRole('button', { name: 'New workspace', exact: true })
    .click();
  const targetName = 'Promotion production';
  const targetId = await createEditorWorkspace(page, targetName);
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width: 1280, height: 800 });
    const workflowName = `Promoted release ${String(width)}`;
    const workflowPath = await createEditorWorkflow(
      page,
      sourceId,
      workflowName,
    );
    await addSingleStep(page, workflowPath, /^Manual/u, 'Release input');
    await publishSingleStep(page, workflowPath);
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/w/${sourceId}/settings/promotion`);
    if (width === 1280) {
      await page
        .getByRole('combobox', { name: 'Promotion target', exact: true })
        .click();
      await page.getByRole('option', { name: targetName, exact: true }).click();
      await page
        .getByRole('button', { name: 'Save target', exact: true })
        .click();
    }
    await expect(
      page.getByRole('heading', {
        name: `Promote to ${targetName}`,
        exact: true,
      }),
    ).toBeVisible();
    const checkbox = page.getByRole('checkbox', {
      name: workflowName,
      exact: true,
    });
    await checkbox.click();
    await expect(checkbox).toBeChecked();
    await page
      .getByRole('button', { name: 'Review promotion', exact: true })
      .click();
    await expect(
      page.getByText('Creates a new target workflow.', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Create target drafts', exact: true }),
    ).toBeEnabled();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await mkdir('/tmp/pertexo-promotion-screenshots', { recursive: true });
    await page.screenshot({
      path: `/tmp/pertexo-promotion-screenshots/review-${String(width)}.png`,
      fullPage: true,
    });
    await page
      .getByRole('button', { name: 'Create target drafts', exact: true })
      .click();
    await page
      .getByRole('link', { name: 'Open target draft r1', exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/w/${targetId}/workflows/[^/]+$`, 'u'),
    );
    const targetWorkflowPath = `/v1/workspaces/${targetId}/workflows/${new URL(page.url()).pathname.split('/')[4] ?? ''}`;
    await publishSingleStep(page, targetWorkflowPath);
    const runId = await startSingleStep(page, { environment: 'target' });
    const result = await waitForRun(page, targetId, runId, 'succeeded');
    expect(result.run.workspaceId).toBe(targetId);
    await page.goto(`/w/${sourceId}/settings/promotion`);
    const history = page.getByRole('region', { name: 'Promotion history' });
    await expect(
      history.getByRole('link', { name: workflowName, exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `/tmp/pertexo-promotion-screenshots/history-${String(width)}.png`,
      fullPage: true,
    });
  }
});
