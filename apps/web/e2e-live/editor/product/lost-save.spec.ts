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
import { expect } from './steps';

// Several real services behind one browser; this stays honest on a busy machine.
test.describe.configure({ timeout: 120_000 });

// product-ux-06: one dropped save in one tab reads as "Changed elsewhere".
test('a save the network dropped is retried and nobody else is blamed', async ({
  page,
  request,
}) => {
  test.fail();
  const mail = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mail === undefined) throw new Error('Use the owned API fixture');
  await registerEditorUser(page, request, mail, 'Solo editor');
  const workspaceId = await createEditorWorkspace(page, 'Solo editing');
  const path = await createEditorWorkflow(page, workspaceId, 'Solo workflow');
  const nodeId = await addSingleStep(page, path, /Set fields/u, 'First name');
  await expect
    .poll(async () => (await readEditorDraft(page, path)).graph.nodes[0]?.label)
    .toBe('First name');
  const before = (await readEditorDraft(page, path)).revision;

  let dropped = 0;
  await page.route(`**${path}/draft`, async (route) => {
    if (route.request().method() === 'PUT' && dropped === 0) {
      dropped += 1;
      await route.abort('connectionreset');
      return;
    }
    await route.continue();
  });
  await page.getByLabel('Label', { exact: true }).fill('Second name');
  await page.keyboard.press('Tab');
  await expect.poll(() => dropped).toBe(1);

  await expect(
    page.getByRole('region', { name: 'Draft conflict' }),
  ).toBeHidden();
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, path)).graph.nodes.find(
          ({ id }) => id === nodeId,
        )?.label,
      { timeout: 20_000 },
    )
    .toBe('Second name');
  expect((await readEditorDraft(page, path)).revision).toBeGreaterThan(before);
  await expect(page.getByText(/^Saved/u)).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
});
