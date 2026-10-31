import { mapBrowserInput } from '../../../test/support/browser/inputs';
import { test } from '../../support/browser-fixture';
import {
  addSingleStep,
  createEditorWorkflow,
  readEditorDraft,
} from '../../support/authoring/single-step';
import {
  createEditorWorkspace,
  registerEditorUser,
} from '../../support/ordinary-editor-session';
import { expect, addStep } from './steps';

// Several real services behind one browser; this stays honest on a busy machine.
test.describe.configure({ timeout: 120_000 });

async function startEditor(
  page: Parameters<typeof registerEditorUser>[0],
  request: Parameters<typeof registerEditorUser>[1],
  name: string,
) {
  const mail = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mail === undefined) throw new Error('Use the owned API fixture');
  await registerEditorUser(page, request, mail, name);
  const workspaceId = await createEditorWorkspace(page, name);
  return createEditorWorkflow(page, workspaceId, name);
}

test('a step that can’t run is flagged in words before publish', async ({
  page,
  request,
}) => {
  const path = await startEditor(page, request, 'Honest issues owner');
  await addStep(page, path, /^Manual\b/u, 'Start by hand');
  await addStep(page, path, /Condition/u, 'Gate with no input');
  const chip = page.locator('#editor-issues-chip');
  await expect(chip).toContainText(/1 issue/u);
  await expect(page.getByText('No issues', { exact: true })).toBeHidden();
  await chip.click();
  const lens = page.locator('#editor-issues-lens');
  await expect(lens).toContainText('Gate with no input');
  await expect(lens).toContainText(/condition/iu);
  await expect(lens).not.toContainText('execution.');
  await expect(
    page.getByRole('button', { name: 'Publish v1', exact: true }),
  ).toBeDisabled();
});

test('a failed test says what’s wrong with the step', async ({
  page,
  request,
}) => {
  const path = await startEditor(page, request, 'Test failure owner');
  const gateId = await addSingleStep(page, path, /Condition/u, 'Gate');
  await mapBrowserInput({
    page,
    field: 'condition',
    path: '$.condition',
    source: 'Run input',
  });
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, path)).graph.nodes[0]?.inputMappings,
    )
    .toEqual({ condition: { kind: 'run_input', path: '$.condition' } });
  await page
    .getByRole('button', { name: 'Test workflow', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Test workflow',
    exact: true,
  });
  await dialog
    .getByLabel('Test input (JSON)', { exact: true })
    .fill(JSON.stringify({ condition: 'not-a-boolean' }));
  await dialog.getByRole('button', { name: 'Start test', exact: true }).click();
  await expect(page.getByText('Test · Failed').first()).toBeVisible();
  await page.getByTestId(`rf__node-${gateId}`).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  const result = page.getByRole('region', {
    name: 'Latest workflow test',
    exact: true,
  });
  await expect(result).toContainText(/condition/iu);
  await expect(result).toContainText(/true or false|boolean/iu);
  await expect(result).not.toContainText('execution.attempt_invalid');
});
