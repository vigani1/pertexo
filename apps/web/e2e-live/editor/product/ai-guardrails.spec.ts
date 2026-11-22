import { expect } from '@playwright/test';
import { mapBrowserInput } from '../../../test/support/browser/inputs';
import { openNewEditorWorkspace } from '../../support/ordinary-editor-session';
import {
  addSingleStep,
  createEditorWorkflow,
  publishSingleStep,
  startSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';
import { test } from './account';
import { modelScreenshots } from './model-editor';

test.use({ actionTimeout: 10_000, viewport: { width: 1280, height: 1080 } });

test('configures Guardrails, routes both outcomes and shows the deciding category', async ({
  page,
}, info) => {
  const workspace = await openNewEditorWorkspace(page, 'Guardrails workspace');
  const path = await createEditorWorkflow(
    page,
    workspace,
    'Review incoming text',
  );
  const editor = new URL(page.url()).pathname;
  const source = await addSingleStep(
    page,
    path,
    /^Guardrails\b/u,
    'Check message',
  );
  await page.getByRole('tab', { name: 'Setup', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Personal information' }),
  ).toBeChecked();
  await page
    .getByRole('checkbox', { name: 'Prompt injection markers' })
    .check();
  await page
    .getByRole('checkbox', { name: 'Prohibited terms', exact: true })
    .check();
  await page
    .getByLabel('Prohibited terms list')
    .fill('wire transfer\ninternal only');
  await page.getByLabel('Prohibited terms list').blur();

  await mapBrowserInput({
    page,
    field: 'text',
    source: 'Run input',
    path: '$.message',
  });
  for (const port of ['Pass', 'Fail']) {
    await page.getByTestId(`rf__node-${source}`).focus();
    await page.keyboard.press('Enter');
    await page
      .getByRole('button', { name: 'Step actions', exact: true })
      .click();
    await page
      .getByRole('menuitem', { name: 'Add step after', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Add a step after “Check message”',
    });
    await dialog.getByLabel('Link from', { exact: true }).click();
    await page.getByRole('option', { name: port, exact: true }).click();
    await dialog.getByRole('button', { name: /Set fields/u }).click();
    await page.getByLabel('Label', { exact: true }).fill(`Route ${port}`);
    await page.keyboard.press('Tab');
  }

  await page.getByTestId(`rf__node-${source}`).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('tab', { name: 'Setup', exact: true }).click();
  await expect(page.getByLabel('Prohibited terms list')).toHaveValue(
    'wire transfer\ninternal only',
  );
  await expect(
    page.getByRole('status').filter({ hasText: /\bSaved\b/u }),
  ).toBeVisible();
  await modelScreenshots(page, info, 'guardrails-setup');
  await publishSingleStep(page, path);
  const sentinel = 'guardrails-journey-sentinel@example.test';
  for (const [port, message] of [
    ['Pass', 'A request for assistance.'],
    ['Fail', sentinel],
  ] as const) {
    await page.goto(editor);
    const run = await startSingleStep(page, { message });
    await waitForRun(page, workspace, run, 'succeeded');
    await expect(
      page.getByRole('button', { name: `Route ${port}: Succeeded` }),
    ).toBeVisible();
    const unselected = port === 'Pass' ? 'Fail' : 'Pass';
    await expect(
      page.getByRole('button', { name: `Route ${unselected}: Succeeded` }),
    ).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Check message: Succeeded' })
      .click();
    const details = page.getByRole('complementary', { name: 'Step details' });
    await expect(details.getByText(port, { exact: true })).toBeVisible();
    if (port === 'Fail') {
      await expect(
        details.getByText('pii.email', { exact: true }),
      ).toBeVisible();
      await expect(details.getByText('1 match', { exact: true })).toBeVisible();
      await expect(details).not.toContainText(sentinel);
      await modelScreenshots(page, info, 'guardrails-fail-run');
    } else {
      await expect(details).toContainText(
        'The enabled checks found no matches.',
      );
    }
  }
});
