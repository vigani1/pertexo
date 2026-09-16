import { csrfTokenSchema } from '@pertexo/contracts/schemas/transport';

const CSRF_COOKIE_NAME = 'pertexo_csrf';

function decodeCookieValue(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function readBrowserCsrfToken(
  cookieHeader: string = document.cookie,
): string | undefined {
  for (const segment of cookieHeader.split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 0) continue;
    const name = segment.slice(0, separator).trim();
    if (name !== CSRF_COOKIE_NAME) continue;
    const decoded = decodeCookieValue(segment.slice(separator + 1));
    const parsed = csrfTokenSchema.safeParse(decoded);
    return parsed.success ? parsed.data : undefined;
  }
  return undefined;
}
