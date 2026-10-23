import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { expect } from 'vitest';

import { apiUrl } from './environment.js';
import { mailedMessages } from './mail.js';
import { runtime } from './lifecycle.js';

export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error('Expected integration fixture value');
  return value;
}

/** Signs up, verifies and signs in a password user through Better Auth. */
export async function signInVerifiedUser(email: string, name: string) {
  const password = `${name} secure password`;
  const signUp = await authRequest('/v1/auth/sign-up/email', {
    name,
    email,
    password,
    callbackURL: '/login',
  });
  expect(signUp.status).toBe(200);
  const verification = mailedMessages(email).find(
    (message) => message.purpose === 'verification',
  );
  expect(verification).toBeDefined();
  await followMailLink(verification?.url ?? 'http://invalid', '');
  const signIn = await authRequest('/v1/auth/sign-in/email', {
    email,
    password,
    callbackURL: '/workspaces',
  });
  expect(signIn.status).toBe(200);
  const cookie = cookieValue(signIn.headers.getSetCookie());
  const authenticated = await runtime.sessions.authenticate(cookie ?? '');
  expect(authenticated).toBeDefined();
  return { cookie, authenticated };
}

export function authRequest(path: string, body: object): Promise<Response> {
  return runtime.auth.handler(
    new Request(`http://pertexo.test${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin: 'http://pertexo.test',
      },
      body: JSON.stringify(body),
    }),
  );
}

export function cookieValue(cookies: readonly string[]): string | undefined {
  const prefix = 'pertexo_session=';
  const cookie = cookies.find((value) => value.startsWith(prefix));
  return cookie?.slice(prefix.length).split(';', 1)[0];
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function cookieName(cookie: string): string {
  return cookie.split('=', 1)[0] ?? '';
}

export function authenticatedRequest({
  path,
  method,
  sessionCookie,
  csrf,
  body,
}: Readonly<{
  path: string;
  method: 'GET' | 'POST';
  sessionCookie: string;
  csrf: string | undefined;
  body?: object | undefined;
}>): Promise<Response> {
  const cookie = [
    `pertexo_session=${sessionCookie}`,
    ...(csrf === undefined ? [] : [`pertexo_csrf=${encodeURIComponent(csrf)}`]),
  ].join('; ');
  return runtime.auth.handler(
    new Request(`http://pertexo.test${path}`, {
      method,
      headers: {
        accept: 'application/json',
        cookie,
        origin: 'http://pertexo.test',
        ...(csrf === undefined ? {} : { 'x-csrf-token': csrf }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

export function followMailLink(
  url: string,
  sessionCookie: string,
): Promise<Response> {
  return runtime.auth.handler(
    new Request(url, {
      headers: {
        cookie: `pertexo_session=${sessionCookie}`,
        origin: 'http://pertexo.test',
      },
      redirect: 'manual',
    }),
  );
}

export async function createInvitationProofSession(
  userId: string,
): Promise<string> {
  const pool = new Pool({ connectionString: apiUrl, max: 1 });
  try {
    const existing = (
      await pool.query<{ id: string }>(
        'select id from app.auth_sessions where user_id=$1 and expires_at>clock_timestamp() order by created_at desc,id limit 1',
        [userId],
      )
    ).rows[0];
    if (existing !== undefined) return existing.id;
    const id = randomUUID();
    await pool.query(
      "insert into app.auth_sessions(id,user_id,token,expires_at) values($1,$2,$3,clock_timestamp()+interval '1 hour')",
      [id, userId, randomUUID()],
    );
    return id;
  } finally {
    await pool.end();
  }
}
