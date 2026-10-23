import { randomUUID } from 'node:crypto';

import type { SessionCookies } from './contract.js';

/** The session cookie stays encoded, as a browser would send it back. */
export function sessionCookies(
  header: string | string[] | undefined,
): SessionCookies {
  const values = Array.isArray(header) ? header : [header ?? ''];
  const session = rawCookieValue(values, 'pertexo_session');
  const csrf = cookieValue(values, 'pertexo_csrf');
  return {
    rawSession: session,
    csrf,
    cookieHeader: `pertexo_session=${session}; pertexo_csrf=${encodeURIComponent(csrf)}`,
  };
}

export function rawCookieValue(
  values: readonly string[],
  name: string,
): string {
  const prefix = `${name}=`;
  for (const value of values) {
    const pair = value.split(';', 1)[0]?.trim();
    if (pair?.startsWith(prefix)) return pair.slice(prefix.length);
  }
  throw new Error(`${name} cookie was not returned`);
}

export function cookieValue(values: readonly string[], name: string): string {
  return decodeURIComponent(rawCookieValue(values, name));
}

export function mutationHeaders(
  cookies: SessionCookies,
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return {
    cookie: cookies.cookieHeader,
    'idempotency-key': `command-${randomUUID()}`,
    'x-csrf-token': cookies.csrf,
    ...extra,
  };
}
