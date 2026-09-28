import type { APIRequestContext, Locator } from '@playwright/test';

/** Catch Playwright call logs before they reach the live reporter. */
export async function fillOwnedHttpCredential(
  field: Pick<Locator, 'fill'>,
  secret: string,
) {
  try {
    await field.fill(secret);
  } catch {
    throw new Error(
      'Owned HTTP credential entry failed; sensitive details omitted.',
    );
  }
}

export async function invokeOwnedWebhook(
  request: APIRequestContext,
  controlOrigin: string,
  data: Readonly<Record<string, string>>,
) {
  try {
    return await request.post(`${controlOrigin}/http-invoke`, {
      data,
      timeout: 10_000,
    });
  } catch {
    throw new Error('Owned webhook sender failed; sensitive details omitted.');
  }
}
