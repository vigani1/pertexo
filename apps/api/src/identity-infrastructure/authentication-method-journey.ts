import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

/*
 * Primitives shared by the browser-bound authentication-method journeys:
 * account linking and legacy-method migration. A journey binds one browser
 * with a short-lived HttpOnly cookie and single-use state digests, and ends by
 * attaching a freshly proven provider method while every browser session of
 * the user is replaced in the same commit.
 */

type MethodAuditFact = 'method.linked' | 'legacy.method_migrated';

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

export async function inTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Attaches a provider account proven in this journey and audits it. */
export async function attachProviderMethod(
  client: PoolClient,
  input: Readonly<{
    userId: string;
    providerId: string;
    accountId: string;
    auditFact: MethodAuditFact;
  }>,
): Promise<void> {
  await client.query(
    `insert into app.auth_accounts(id,account_id,provider_id,user_id)
     values($1,$2,$3,$4)`,
    [randomUUID(), input.accountId, input.providerId, input.userId],
  );
  await client.query('select app.record_identity_method_audit_fact($1,$2)', [
    input.userId,
    input.auditFact,
  ]);
}

/**
 * Revokes every Better Auth session of the user and mints the single
 * replacement session token that the journey delivers to its browser.
 */
export async function replaceBrowserSessions(
  client: PoolClient,
  userId: string,
  sessionTtlSeconds: number,
): Promise<string> {
  await client.query('delete from app.auth_sessions where user_id=$1', [
    userId,
  ]);
  const token = newJourneyToken();
  await client.query(
    `insert into app.auth_sessions(id,expires_at,token,user_id)
     values($1,clock_timestamp()+($2::integer*interval '1 second'),$3,$4)`,
    [randomUUID(), sessionTtlSeconds, token, userId],
  );
  return token;
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

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}
