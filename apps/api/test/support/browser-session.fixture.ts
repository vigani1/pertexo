import { DoubleSubmitCsrfPolicy } from '../../src/identity/index.js';
import type { IdentitySessionAuthority } from '../../src/workspaces/index.js';

export type HttpSessionCookies = Readonly<{
  rawSession: string;
  csrf: string;
  cookieHeader: string;
}>;

/**
 * A signed-in browser for an existing user: a real Better Auth session issued
 * by the session authority, with the double-submit CSRF pair a sign-in sets.
 */
export async function issueBrowserSession(
  sessions: IdentitySessionAuthority,
  userId: string,
): Promise<HttpSessionCookies> {
  const setCookies: string[] = [];
  await sessions.issue(
    { userId },
    {
      writeSessionCookieHeaders: (values) => {
        setCookies.push(...values);
      },
    },
  );
  const rawSession = readSetCookieValue(setCookies, 'pertexo_session');
  const csrf = new DoubleSubmitCsrfPolicy().issueToken();
  return {
    rawSession,
    csrf,
    cookieHeader: `pertexo_session=${rawSession}; pertexo_csrf=${csrf}`,
  };
}

/** One named cookie's value as the browser sends it back, still encoded. */
function readSetCookieValue(values: readonly string[], name: string): string {
  const prefix = `${name}=`;
  for (const value of values) {
    const pair = value.split(';', 1)[0]?.trim();
    if (pair?.startsWith(prefix)) return pair.slice(prefix.length);
  }
  throw new Error(`${name} cookie was not returned`);
}
