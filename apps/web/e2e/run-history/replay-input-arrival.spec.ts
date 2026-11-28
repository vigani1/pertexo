import { mkdir } from 'node:fs/promises';
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
    await expect(dialog).toHaveAttribute('data-side', 'right');
    expect((await dialog.boundingBox())?.width).toBe(375);
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

const capture = process.env.PERTEXO_WEFT_SHOTS;
if (capture !== undefined) {
  for (const [width, height] of [
    [390, 844],
    [768, 1024],
    [1024, 768],
    [1280, 900],
    [1440, 900],
  ] as const) {
    for (const colorScheme of ['dark', 'light'] as const) {
      test(`Replay framing at ${String(width)}px in ${colorScheme}`, async ({
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
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme });
        await installRoutes(page);
        await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);
        await page.getByRole('button', { name: 'Replay', exact: true }).click();
        const drawer = page.getByRole('dialog', { name: 'Replay this run' });
        await expect(
          drawer.getByRole('button', { name: 'Replay run' }),
        ).toBeEnabled();
        await expect(drawer).toHaveAttribute('data-side', 'right');
        const frame = await drawer.boundingBox();
        if (frame === null) throw new Error('Replay drawer must be visible');
        if (width < 600) expect(frame.width).toBe(width);
        else expect(width - (frame.x + frame.width)).toBeCloseTo(12);
        await mkdir(capture, { recursive: true });
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: `${capture}/replay-${String(width)}-${colorScheme}.png`,
        });
      });
    }
  }
}
