import {
  csrfToken,
  firstRunId,
  installRoutes,
  replayRunId,
  workspaceId,
} from './fixture';
import { expect, test } from '../support/fixtures';

for (const initialRead of ['success', 'failure'] as const) {
  test(`waits for a ${initialRead} saved-input read before replacing selected replay text by keyboard at phone width`, async ({
    context,
    page,
    baseURL,
  }) => {
    await context.addCookies([
      {
        name: 'pertexo_csrf',
        value: csrfToken,
        url: baseURL ?? 'http://127.0.0.1:4173',
      },
    ]);
    await page.setViewportSize({ width: 375, height: 768 });
    await installRoutes(page);
    let release: () => void = () => undefined;
    let arrived: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let reads = 0;
    await page.route(`**/runs/${firstRunId}/input`, async (route) => {
      reads += 1;
      if (reads > 1) {
        await route.fallback();
        return;
      }
      arrived();
      await held;
      if (initialRead === 'success') await route.fallback();
      else
        await route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'about:blank',
            status: 503,
            title: 'Saved input temporarily unavailable',
            code: 'internal.unexpected',
          }),
        });
    });
    const posts: unknown[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        request.url().endsWith(`/runs/${firstRunId}/replay`)
      )
        posts.push(request.postDataJSON());
    });
    await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);
    await page.getByRole('button', { name: 'Replay', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Replay this run' });
    const editor = dialog.getByLabel('Replay input (JSON)');
    const submit = dialog.getByRole('button', { name: 'Replay run' });
    const replacement = '{"incident":"INC-42"}';
    try {
      await requested;
      // Reproduce the selection/insertion boundary while the actual GET is held.
      await editor.evaluate((element: HTMLTextAreaElement) => {
        element.focus();
        element.select();
      });
      await page.keyboard.press('ControlOrMeta+A');
      await expect(editor).toBeDisabled();
      await expect(submit).toBeDisabled();
      await submit.evaluate((element: HTMLButtonElement) =>
        element.form?.requestSubmit(),
      );
      expect(posts).toEqual([]);
      // A successful arrival unlocks the queued fill. A failed read requires
      // explicit recovery before either editing or sending becomes available.
      const filling =
        initialRead === 'success' ? editor.fill(replacement) : undefined;
      release();
      if (initialRead === 'failure') {
        const retry = dialog.getByRole('button', { name: 'Retry saved input' });
        await expect(retry).toBeVisible();
        await expect(editor).toBeDisabled();
        await expect(submit).toBeDisabled();
        await submit.evaluate((element: HTMLButtonElement) =>
          element.form?.requestSubmit(),
        );
        expect(posts).toEqual([]);
        await retry.click();
        await expect(editor).toBeEnabled();
        expect(JSON.parse(await editor.inputValue())).toEqual({
          incident: 'INC-41',
        });
        expect(reads).toBe(2);
      }
      await (filling ?? editor.fill(replacement));
      await expect(editor).toHaveValue(replacement);
      await editor.focus();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.insertText(replacement);
      await expect(editor).toHaveValue(replacement);
      await submit.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`/w/${workspaceId}/runs/${replayRunId}`);
      expect(posts).toEqual([
        expect.objectContaining({ input: { incident: 'INC-42' } }),
      ]);
    } finally {
      release();
    }
  });
}
