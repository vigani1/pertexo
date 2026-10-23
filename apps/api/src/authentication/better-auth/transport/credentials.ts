import { randomBytes } from 'node:crypto';

export function tokenFreeAuthenticationBody(
  body: Uint8Array,
  headers: Headers,
): Uint8Array {
  if (!headers.get('content-type')?.includes('application/json')) return body;
  try {
    const value = JSON.parse(new TextDecoder().decode(body)) as unknown;
    return new TextEncoder().encode(JSON.stringify(removeTokenFields(value)));
  } catch {
    return body;
  }
}

function removeTokenFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeTokenFields);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, field]) =>
      isTokenField(name) ? [] : [[name, removeTokenFields(field)]],
    ),
  );
}

function isTokenField(name: string): boolean {
  return ['token', 'accessToken', 'refreshToken', 'idToken'].includes(name);
}

export function establishesPertexoSession(cookie: string): boolean {
  return (
    cookie.startsWith('pertexo_session=') &&
    !/(?:^|;)\s*Max-Age=0(?:;|$)/iu.test(cookie)
  );
}

export function serializeCsrfCookie(
  options: Readonly<{
    secure: boolean;
    sameSite: 'lax' | 'strict' | 'none';
    maxAgeSeconds: number;
  }>,
): string {
  return [
    `pertexo_csrf=${randomBytes(32).toString('base64url')}`,
    'Path=/',
    options.secure ? 'Secure' : undefined,
    `SameSite=${options.sameSite[0]?.toUpperCase() ?? ''}${options.sameSite.slice(1)}`,
    `Max-Age=${String(options.maxAgeSeconds)}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join('; ');
}
