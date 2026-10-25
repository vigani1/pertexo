import {
  workflowRunListResponseSchema,
  workflowTestSuiteAcceptedSchema,
  workflowTestSuiteDetailSchema,
} from '@pertexo/contracts';
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readCsrfToken } from '../../../test/support/browser/csrf';
import {
  addSingleStep,
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
} from '../../support/authoring/single-step';
import { openWorkflowAction } from '../../support/authoring/workflow-actions';
import { test } from '../../support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from '../../support/ordinary-editor-session';
test('saved input cases run as a serial suite with reports, pins and advisory publication warnings', async ({
  page,
  request,
}) => {
  test.setTimeout(180000);
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Use the owned API fixture');
  await registerEditorUser(page, request, mailOrigin, 'Suite owner');
  const workspaceId = await createEditorWorkspace(page, 'Suite qualification');
  const path = await createEditorWorkflow(
    page,
    workspaceId,
    'Suite qualification',
  );
  const nodeId = await addSingleStep(page, path, /Set fields/u, 'Suite amount');
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  const row = page
    .getByRole('region', { name: 'Inputs', exact: true })
    .locator('ol > li')
    .last();
  await row.getByLabel('Field', { exact: true }).fill('amount');
  await row.getByRole('button', { name: 'Run input', exact: true }).click();
  await row.getByLabel('Run input path', { exact: true }).fill('$.amount');
  await page.keyboard.press('Tab');
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, path)).graph.nodes[0]?.inputMappings,
    )
    .toEqual({ amount: { kind: 'run_input', path: '$.amount' } });
  const publication = await publishSingleStep(page, path);
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await openWorkflowAction(page, 'Input cases');
  const cases = page.getByRole('dialog', { name: 'Input cases', exact: true });
  for (const entry of [
    { name: 'Seven', amount: 7, expected: 7 },
    { name: 'Eight', amount: 8, expected: 9 },
  ]) {
    await cases
      .getByRole('button', { name: 'New input case', exact: true })
      .click();
    await cases.getByLabel('Case name', { exact: true }).fill(entry.name);
    await cases
      .getByLabel('Case input (JSON)', { exact: true })
      .fill(JSON.stringify({ amount: entry.amount }));
    await cases
      .getByRole('button', { name: 'Add value check', exact: true })
      .click();
    await cases.getByRole('combobox', { name: 'Output', exact: true }).click();
    await page
      .getByRole('option', { name: `Suite amount (${nodeId})`, exact: true })
      .click();
    await cases.getByLabel('JSON path', { exact: true }).fill('$.amount');
    await cases
      .getByLabel('Expected value (JSON)', { exact: true })
      .fill(String(entry.expected));
    await cases
      .getByRole('button', { name: 'Save input case', exact: true })
      .click();
    await expect(
      cases.getByRole('button', { name: `Edit ${entry.name}`, exact: true }),
    ).toBeVisible();
  }
  await cases
    .getByRole('button', { name: 'Close input cases', exact: true })
    .click();
  const csrf = await readCsrfToken(page, {
    missingMessage: 'Owned CSRF cookie missing',
  });
  for (let ordinal = 3; ordinal <= 50; ordinal++) {
    const response = await page.request.post(`${path}/input-cases`, {
      headers: {
        'x-csrf-token': csrf,
        'Idempotency-Key': randomUUID(),
      },
      data: {
        workflowVersionId: publication.id,
        name: `Order ${String(ordinal).padStart(2, '0')}`,
        input: { amount: ordinal },
      },
    });
    expect(response.status(), await response.text()).toBe(201);
  }

  // Run all tests lives in the Test workflow button's menu.
  await page
    .getByRole('button', { name: 'More test actions', exact: true })
    .click();
  await page
    .getByRole('menuitem', { name: 'Run all tests', exact: true })
    .click();
  const suiteDialog = page.getByRole('dialog', {
    name: 'Run all tests',
    exact: true,
  });
  await expect(suiteDialog).toContainText('50 cases');
  const started = page.waitForResponse(
    (response) =>
      response.url().endsWith(`${path}/draft/test-suites`) &&
      response.request().method() === 'POST',
  );
  await suiteDialog
    .getByRole('button', { name: 'Start suite', exact: true })
    .click();
  const acceptedResponse = await started;
  expect(acceptedResponse.status(), await acceptedResponse.text()).toBe(202);
  const accepted = workflowTestSuiteAcceptedSchema.parse(
    await acceptedResponse.json(),
  );
  await expect
    .poll(
      async () =>
        workflowTestSuiteDetailSchema.parse(
          await (
            await page.request.get(
              `${path}/draft/test-suites/${accepted.suiteId}`,
            )
          ).json(),
        ).status,
      { timeout: 90000 },
    )
    .toBe('failed');
  // A started suite opens the tests bar on its history.
  const history = page.getByRole('region', {
    name: 'Workflow tests',
    exact: true,
  });
  const suites = page.getByRole('region', { name: 'Test suites', exact: true });
  await expect(
    suites.getByText('Suite · failed', { exact: true }),
  ).toBeVisible();
  await expect(suites).toContainText('49/50 passed');
  await suites
    .getByRole('button', { name: 'Report Eight', exact: true })
    .click();
  await expect(suites).toContainText(
    'Expected: succeeds. Actual: succeeded. Outcome matches.',
  );
  await expect(suites).toContainText(
    'Failed · Step Suite amount · $.amount · equals',
  );
  await expect(suites.locator('pre').first()).toHaveText('9');
  await expect(suites.locator('pre').last()).toHaveText('8');
  await suites.locator('pre').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/pertexo-f02-suites-desktop.png' });
  await page.setViewportSize({ width: 375, height: 768 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(
    suites.getByRole('button', { name: 'Report Eight', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await suites.locator('pre').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/pertexo-f02-suites-phone.png' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await suites
    .getByRole('button', { name: 'View test Seven', exact: true })
    .click();
  await expect(
    history.getByRole('region', {
      name: 'Test result: Suite amount',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    history.getByRole('combobox', {
      name: 'Retained workflow test',
      exact: true,
    }),
  ).toContainText('Succeeded');
  await page.getByTestId(`rf__node-${nodeId}`).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Label', { exact: true }).fill('Updated suite amount');
  await page.keyboard.press('Tab');
  await expect
    .poll(async () => (await readEditorDraft(page, path)).graph.nodes[0]?.label)
    .toBe('Updated suite amount');
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page
    .getByRole('region', { name: 'Inputs', exact: true })
    .locator('ol > li')
    .first()
    .getByLabel('Field', { exact: true })
    .fill('total');
  await page.keyboard.press('Tab');
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, path)).graph.nodes[0]?.inputMappings,
    )
    .toEqual({ total: { kind: 'run_input', path: '$.amount' } });
  await page.getByRole('button', { name: 'Publish v2', exact: true }).click();
  const publish = page.getByRole('dialog', { name: 'Publish v2', exact: true });
  await expect(publish).toContainText('Latest suite: failed');
  await expect(publish).toContainText('Out of date');
  await expect(
    publish.getByRole('button', { name: 'Publish v2', exact: true }),
  ).toBeEnabled();
  await publish.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(
    workflowRunListResponseSchema.parse(
      await (
        await page.request.get(`/v1/workspaces/${workspaceId}/runs`)
      ).json(),
    ).items,
  ).toEqual([]);
});
