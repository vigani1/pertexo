import { randomUUID } from 'node:crypto';

import { betterAuth } from 'better-auth';
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory';
import { createAuthMiddleware } from 'better-auth/api';
import { describe, expect, it } from 'vitest';

const ORIGIN = 'https://pertexo.test';
const AUTH_BASE = `${ORIGIN}/v1/auth`;
const PASSWORD = 'correct horse battery staple';

describe('Better Auth 1.7.5 compatibility', () => {
  it('lets a plugin intercept a purpose-tagged provider callback before native linking', async () => {
    const database: MemoryDB = {
      user: [],
      account: [],
      session: [],
      verification: [],
    };
    let providerWasAvailable = false;
    const auth = betterAuth({
      baseURL: ORIGIN,
      basePath: '/v1/auth',
      secret: 'A0-proof-only-secret-with-at-least-32-characters',
      database: memoryAdapter(database),
      socialProviders: {
        google: { clientId: 'local-client', clientSecret: 'local-secret' },
      },
      plugins: [
        {
          id: 'pertexo-link-hook-proof',
          hooks: {
            before: [
              {
                matcher: (context) => context.path === '/callback/:id',
                handler: createAuthMiddleware((context) => {
                  const state: unknown = context.query?.state;
                  if (
                    typeof state !== 'string' ||
                    !state.startsWith('pertexo-link-v1.')
                  )
                    return Promise.resolve();
                  providerWasAvailable = context.context.socialProviders.some(
                    (provider) => provider.id === 'google',
                  );
                  throw context.redirect('/account/security?linked=failed');
                }),
              },
            ],
          },
        },
      ],
      telemetry: { enabled: false },
    });
    const response = await auth.handler(
      new Request(`${AUTH_BASE}/callback/google?state=pertexo-link-v1.opaque`, {
        headers: { origin: ORIGIN },
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      '/account/security?linked=failed',
    );
    expect(providerWasAvailable).toBe(true);
    expect(database.account).toHaveLength(0);
  });

  it('preserves the supported database session lifecycle and signed cookie boundary', async () => {
    const sessionCreationPaths: string[] = [];
    const database: MemoryDB = {
      user: [],
      account: [],
      session: [],
      verification: [],
    };
    const auth = betterAuth({
      appName: 'Pertexo',
      baseURL: ORIGIN,
      basePath: '/v1/auth',
      secret: 'A0-proof-only-secret-with-at-least-32-characters',
      database: memoryAdapter(database),
      emailAndPassword: { enabled: true, minPasswordLength: 12 },
      account: { accountLinking: { disableImplicitLinking: true } },
      session: { expiresIn: 60, updateAge: 1 },
      databaseHooks: {
        session: {
          create: {
            after: (_session, context) => {
              sessionCreationPaths.push(context?.path ?? '');
              return Promise.resolve();
            },
          },
        },
      },
      advanced: {
        database: { generateId: () => randomUUID() },
        useSecureCookies: true,
      },
      telemetry: { enabled: false },
    });

    const first = await request(auth, '/sign-up/email', {
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      password: PASSWORD,
    });
    expect(first.response.status).toBe(200);
    expect(first.cookie).toMatch(/^__Secure-better-auth\.session_token=/u);

    const persisted = onlySession(database);
    const browserCredential = cookieValue(first.cookie);
    expect(browserCredential).toContain('.');
    expect(browserCredential).not.toBe(persisted.token);
    expect(decodeURIComponent(browserCredential).split('.')[0]).toBe(
      persisted.token,
    );
    expect(persisted.id).toMatch(/^[0-9a-f-]{36}$/u);

    const lookup = await request(auth, '/get-session', undefined, first.cookie);
    expect(lookup.response.status).toBe(200);
    expect((lookup.body as { session: { id: string } }).session.id).toBe(
      persisted.id,
    );

    const second = await request(auth, '/sign-in/email', {
      email: 'ada@example.test',
      password: PASSWORD,
    });
    expect(second.response.status).toBe(200);
    expect(sessionCreationPaths).toContain('/sign-in/email');
    expect(database.session).toHaveLength(2);

    const listed = await request(
      auth,
      '/list-sessions',
      undefined,
      second.cookie,
    );
    expect(listed.response.status).toBe(200);
    expect(listed.body).toHaveLength(2);

    const firstToken = persisted.token;
    const revoked = await request(
      auth,
      '/revoke-session',
      { token: firstToken },
      second.cookie,
    );
    expect(revoked.response.status).toBe(200);
    expect(database.session).toHaveLength(1);
    expect(
      (await request(auth, '/get-session', undefined, first.cookie)).body,
    ).toBeNull();

    const third = await request(auth, '/sign-in/email', {
      email: 'ada@example.test',
      password: PASSWORD,
    });
    expect(database.session).toHaveLength(2);
    const revokeOther = await request(
      auth,
      '/revoke-other-sessions',
      undefined,
      third.cookie,
    );
    expect(revokeOther.response.status).toBe(200);
    expect(database.session).toHaveLength(1);

    const revokeAll = await request(
      auth,
      '/revoke-sessions',
      undefined,
      third.cookie,
    );
    expect(revokeAll.response.status).toBe(200);
    expect(database.session).toHaveLength(0);
  });
});

type CompatibilityAuth = Readonly<{
  handler(request: Request): Promise<Response>;
}>;

async function request(
  auth: CompatibilityAuth,
  path: string,
  body?: Record<string, unknown>,
  cookie?: string,
): Promise<Readonly<{ response: Response; body: unknown; cookie: string }>> {
  const response = await auth.handler(
    new Request(`${AUTH_BASE}${path}`, {
      method:
        body === undefined &&
        (path === '/get-session' || path === '/list-sessions')
          ? 'GET'
          : 'POST',
      headers: {
        origin: ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie === undefined ? {} : { cookie }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return Object.freeze({
    response,
    body: text === '' ? undefined : (JSON.parse(text) as unknown),
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(';', 1)[0])
      .filter((value): value is string => value !== undefined)
      .join('; '),
  });
}

function onlySession(database: MemoryDB): Record<string, string> {
  expect(database.session).toHaveLength(1);
  return database.session?.[0] as Record<string, string>;
}

function cookieValue(cookie: string): string {
  const separator = cookie.indexOf('=');
  expect(separator).toBeGreaterThan(0);
  return cookie.slice(separator + 1);
}
