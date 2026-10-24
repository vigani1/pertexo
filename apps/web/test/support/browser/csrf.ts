import type { Page } from '@playwright/test';

/** Read the ordinary browser session rather than seeding a second auth path. */
export async function readCsrfToken(page: Page): Promise<string> {
  const cookie = (await page.context().cookies()).find(
    (value) => value.name === 'pertexo_csrf',
  );
  if (cookie === undefined) throw new Error('Ordinary CSRF cookie missing');
  return decodeURIComponent(cookie.value);
}

export async function csrfHeaders(page: Page) {
  return { 'x-csrf-token': await readCsrfToken(page) };
}
