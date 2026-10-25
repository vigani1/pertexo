import { chooseTestAction, expect, test } from '../../support/fixtures';
import { editorNode } from '../graph';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workspaceId,
} from '../support';

for (const width of [375, 1280]) {
  test(`draft tests list real effects and retain the exact uncertain command at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await addCsrfCookie(context);
    const remote = remoteDraft({
      nodes: [editorNode('send', 'Send invoice', 'value', 80)],
      edges: [],
      settings: {},
    });
    await installEditorRoutes(page, remote);
    const root = `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft/tests`;
    await page.route(`${root}/prepare`, (route) =>
      route.fulfill({
        json: {
          draftRevision: 1,
          samples: [],
          effectfulSteps: [{ nodeId: 'send', label: 'Send invoice' }],
        },
      }),
    );
    const commands: { body: unknown; key: string | undefined }[] = [];
    await page.route(root, async (route) => {
      if (route.request().method() === 'GET')
        return route.fulfill({ json: { items: [] } });
      commands.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()['idempotency-key'],
      });
      await route.abort('failed');
    });
    await page.goto(editorUrl);
    await chooseTestAction(page, 'Test workflow');
    const dialog = page.getByRole('dialog', {
      name: 'Test workflow',
      exact: true,
    });
    await expect(
      dialog
        .getByRole('region', { name: 'Steps with effects' })
        .getByText('Send invoice', { exact: true }),
    ).toBeVisible();
    const start = dialog.getByRole('button', {
      name: 'Start test',
      exact: true,
    });
    await expect(start).toBeDisabled();
    await dialog
      .getByLabel('Test input (JSON)', { exact: true })
      .fill('{"invoice":42}');
    await dialog
      .getByRole('switch', { name: 'I understand this test runs for real' })
      .click();
    await expect(start).toBeEnabled();
    const input = dialog.getByLabel('Test input (JSON)', { exact: true });
    await input.fill('{');
    await start.click();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toBeFocused();
    expect(commands).toEqual([]);
    await input.fill('{"invoice":42}');
    await expect(input).toHaveAttribute('aria-invalid', 'false');

    await start.click();
    const retry = dialog.getByRole('button', {
      name: 'Retry same test request',
      exact: true,
    });
    await expect(retry).toBeEnabled();
    await expect(
      dialog.getByLabel('Test input (JSON)', { exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole('button', { name: 'Close', exact: true }),
    ).toBeDisabled();
    await retry.click();
    await expect.poll(() => commands.length).toBe(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[0]?.body).toEqual({
      expectedRevision: 1,
      expectedSamples: [],
      expectedEffectfulSteps: ['send'],
      input: { invoice: 42 },
      acknowledgeSideEffects: true,
    });
    expect(commands[0]?.key).toBeTruthy();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
