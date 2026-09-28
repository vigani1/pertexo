import type { Page } from '@playwright/test';

/** A failed goto must not expose its verification token through call logs. */
export async function openVerificationLink(
  page: Pick<Page, 'goto'>,
  path: string,
): Promise<void> {
  try {
    await page.goto(path);
  } catch {
    throw new Error(
      'Could not open the verification link; sensitive navigation details omitted.',
    );
  }
}
