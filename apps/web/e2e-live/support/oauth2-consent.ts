import type { Locator, Page } from '@playwright/test';

export async function clickConnect(
  page: Page,
  scope: Locator,
  name: 'Connect' | 'Reconnect' = 'Connect',
): Promise<Page> {
  const opened = page.waitForEvent('popup');
  await scope.getByRole('button', { name, exact: true }).click();
  return opened;
}

/** A consent window closes itself, unless the browser refuses: then it says so. */
export async function closesOrSays(popup: Page, text: string): Promise<void> {
  await Promise.race([
    popup.waitForEvent('close'),
    popup.getByText(text, { exact: true }).waitFor(),
  ]);
}
