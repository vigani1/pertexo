import type { BrowserContext, Page } from '@playwright/test';

/**
 * Lets the page write the clipboard from a click, as every browser does for
 * the focused page. Firefox and WebKit already allow it; Playwright's
 * Chromium asks for the permission, and the others reject the name.
 */
export async function allowClipboardWrites(
  context: BrowserContext,
  browserName: string,
) {
  if (browserName === 'chromium')
    await context.grantPermissions(['clipboard-write']);
}

/**
 * What the clipboard holds, read by pasting it with the keyboard into a
 * scratch field, as a person would. Firefox and WebKit grant no clipboard
 * permission to tests, so `navigator.clipboard.readText` works only in
 * Chromium. The field sits in the open dialog, if any, so a modal's inert
 * page cannot refuse its focus; focus returns where it was.
 */
export async function readClipboard(page: Page): Promise<string> {
  await page.evaluate(() => {
    const previous = document.activeElement;
    const field = document.createElement('textarea');
    field.id = 'clipboard-probe';
    (previous?.closest('[role="dialog"]') ?? document.body).append(field);
    field.focus();
    (window as { clipboardProbeReturn?: Element | null }).clipboardProbeReturn =
      previous;
  });
  await page.keyboard.press('ControlOrMeta+V');
  return page.evaluate(() => {
    const field = document.getElementById(
      'clipboard-probe',
    ) as HTMLTextAreaElement;
    const text = field.value;
    field.remove();
    const back = (window as { clipboardProbeReturn?: Element | null })
      .clipboardProbeReturn;
    if (back instanceof HTMLElement) back.focus();
    return text;
  });
}

/**
 * Puts `text` on the clipboard by copying it with the keyboard from a
 * scratch field, so a paste that follows is the browser's own.
 */
export async function copyToClipboard(page: Page, text: string) {
  await page.evaluate((value) => {
    const field = document.createElement('textarea');
    field.id = 'clipboard-source';
    field.value = value;
    (
      document.activeElement?.closest('[role="dialog"]') ?? document.body
    ).append(field);
    field.select();
  }, text);
  await page.keyboard.press('ControlOrMeta+C');
  await page.evaluate(() => {
    document.getElementById('clipboard-source')?.remove();
  });
}
