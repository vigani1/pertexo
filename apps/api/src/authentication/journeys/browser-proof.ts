import { createHash, createHmac, randomBytes } from 'node:crypto';

/*
 * Primitives of the browser-bound account-linking journey. A journey binds
 * one browser with a short-lived HttpOnly cookie and single-use state
 * digests, and ends by attaching a freshly proven provider method while every
 * browser session of the user is replaced in the same commit.
 */

/** 256 bits of URL-safe random proof material. */
export function newJourneyToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isJourneyToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/u.test(value);
}

/** Journey tokens are stored and compared only as SHA-256 digests. */
export function journeyDigest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Derives per-journey PKCE and nonce material that is never persisted. */
export function deriveJourneySecret(secret: string, purpose: string): string {
  return createHmac('sha256', secret).update(purpose).digest('base64url');
}

export function readCookie(headers: Headers, name: string): string | undefined {
  return headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/** A five-minute HttpOnly binding scoped to the journey's callback path. */
export function journeyBindingCookie(
  input: Readonly<{
    name: string;
    value: string;
    path: string;
    secure: boolean;
  }>,
): string {
  return `${input.name}=${input.value}; Path=${input.path}; HttpOnly; SameSite=Lax; Max-Age=300${input.secure ? '; Secure' : ''}`;
}

/**
 * The method change is already committed, so a failed cookie delivery sends
 * the browser to ordinary sign-in: a callback retry cannot repeat the journey.
 */
export async function landWithReplacementSession(
  deliver: (token: string) => Promise<readonly string[]>,
  token: string,
  landing: () => Response,
  recovery: () => Response,
): Promise<Response> {
  try {
    const cookies = await deliver(token);
    const response = landing();
    for (const cookie of cookies) response.headers.append('set-cookie', cookie);
    return response;
  } catch {
    return recovery();
  }
}
