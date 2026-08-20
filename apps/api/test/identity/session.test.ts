import { describe, expect, it } from 'vitest';

import {
  DoubleSubmitCsrfPolicy,
  IdentityError,
  OpaqueSessionService,
  type SessionCookieOptions,
  type SessionRecord,
  type SessionStorePort,
} from '../../src/identity/index.js';

const userId = '11111111-1111-4111-8111-111111111111';

class FakeClock {
  current = new Date('2026-08-20T12:00:00.000Z');
  now = (): Date => new Date(this.current);
}

class FakeSessions implements SessionStorePort {
  readonly records = new Map<string, SessionRecord>();

  create(record: SessionRecord): Promise<void> {
    this.records.set(record.tokenDigest, record);
    return Promise.resolve();
  }

  findByDigest(tokenDigest: string): Promise<SessionRecord | undefined> {
    return Promise.resolve(this.records.get(tokenDigest));
  }

  revokeByDigest(tokenDigest: string, revokedAt: Date): Promise<boolean> {
    const record = this.records.get(tokenDigest);
    if (record === undefined) return Promise.resolve(false);
    this.records.set(tokenDigest, { ...record, revokedAt });
    return Promise.resolve(true);
  }
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('test fixture value is missing');
  return value;
}

class CookieSink {
  token?: string;
  options?: SessionCookieOptions;

  writeSessionCookie(token: string, options: SessionCookieOptions): void {
    this.token = token;
    this.options = options;
  }
}

describe('opaque browser sessions', () => {
  it('persists only a digest and hands the raw token once to the cookie boundary', async () => {
    const store = new FakeSessions();
    const sink = new CookieSink();
    const service = new OpaqueSessionService(store, {
      clock: new FakeClock(),
      ttlMillis: 60_000,
      secureCookie: true,
      sameSite: 'lax',
    });
    const issued = await service.issue(
      {
        userId,
        clientMetadata: { requestId: 'req-1', userAgent: 'test' },
      },
      sink,
    );

    expect(sink.token).toBeDefined();
    expect(sink.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
    expect(issued).not.toHaveProperty('token');
    expect([...store.records.values()]).toHaveLength(1);
    const persisted = defined([...store.records.values()][0]);
    expect(persisted.tokenDigest).not.toBe(sink.token);
    expect(persisted.tokenDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(persisted.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(JSON.stringify(persisted)).not.toContain(defined(sink.token));
    await expect(
      service.authenticate(defined(sink.token)),
    ).resolves.toMatchObject({ userId });
  });

  it('rejects revoked and expired sessions, and rotates a valid session', async () => {
    const clock = new FakeClock();
    const store = new FakeSessions();
    const firstCookie = new CookieSink();
    const service = new OpaqueSessionService(store, {
      clock,
      ttlMillis: 60_000,
    });
    await service.issue({ userId }, firstCookie);
    await service.revoke(defined(firstCookie.token));
    await expect(
      service.authenticate(defined(firstCookie.token)),
    ).rejects.toMatchObject({
      code: 'identity.session_revoked',
    });

    const secondCookie = new CookieSink();
    await service.issue({ userId }, secondCookie);
    clock.current = new Date('2026-08-20T12:01:00.000Z');
    await expect(
      service.authenticate(defined(secondCookie.token)),
    ).rejects.toMatchObject({
      code: 'identity.session_expired',
    });

    const thirdCookie = new CookieSink();
    const rotateClock = new FakeClock();
    const rotateStore = new FakeSessions();
    const rotateService = new OpaqueSessionService(rotateStore, {
      clock: rotateClock,
    });
    const oldCookie = new CookieSink();
    await rotateService.issue({ userId }, oldCookie);
    const rotated = await rotateService.rotate(
      defined(oldCookie.token),
      thirdCookie,
    );
    expect(rotated.sessionId).not.toBe(
      defined([...rotateStore.records.values()][0]).sessionId,
    );
    await expect(
      rotateService.authenticate(defined(oldCookie.token)),
    ).rejects.toMatchObject({
      code: 'identity.session_revoked',
    });
    await expect(
      rotateService.authenticate(defined(thirdCookie.token)),
    ).resolves.toMatchObject({
      userId,
    });
  });

  it('uses double-submit protection for cookie mutations and permits safe reads', () => {
    const csrf = new DoubleSubmitCsrfPolicy();
    const token = csrf.issueToken();
    expect(() => {
      csrf.assertMutationAllowed({ method: 'GET' });
    }).not.toThrow();
    expect(() => {
      csrf.assertMutationAllowed({
        method: 'POST',
        cookieToken: token,
        headerToken: token,
      });
    }).not.toThrow();
    expect(() => {
      csrf.assertMutationAllowed({
        method: 'POST',
        cookieToken: token,
        headerToken: `${token}x`,
      });
    }).toThrow(expect.objectContaining({ code: 'identity.csrf_failed' }));
    expect(() => {
      csrf.assertMutationAllowed({ method: 'DELETE', cookieToken: token });
    }).toThrow(expect.objectContaining({ code: 'identity.csrf_failed' }));
  });

  it('revokes a persisted session when cookie delivery fails', async () => {
    const store = new FakeSessions();
    const service = new OpaqueSessionService(store);
    const failingCookie = {
      writeSessionCookie: (): never => {
        throw new Error('cookie sink unavailable');
      },
    };
    await expect(
      service.issue({ userId }, failingCookie),
    ).rejects.toMatchObject({
      code: 'identity.session_invalid',
    });
    const persisted = defined([...store.records.values()][0]);
    expect(persisted.revokedAt).toBeInstanceOf(Date);
  });

  it('rejects malformed store identifiers and invalid dates at the session boundary', async () => {
    const store = new FakeSessions();
    const service = new OpaqueSessionService(store);
    const cookie = new CookieSink();
    await service.issue({ userId }, cookie);
    const persisted = defined([...store.records.values()][0]);

    store.records.set(persisted.tokenDigest, {
      ...persisted,
      sessionId: 'not-a-uuid',
    });
    await expect(
      service.authenticate(defined(cookie.token)),
    ).rejects.toMatchObject({
      code: 'identity.session_invalid',
    });

    store.records.set(persisted.tokenDigest, {
      ...persisted,
      userId: 'not-a-uuid',
    });
    await expect(
      service.authenticate(defined(cookie.token)),
    ).rejects.toMatchObject({
      code: 'identity.session_invalid',
    });

    store.records.set(persisted.tokenDigest, {
      ...persisted,
      expiresAt: new Date('not-a-date'),
    });
    await expect(
      service.authenticate(defined(cookie.token)),
    ).rejects.toMatchObject({
      code: 'identity.session_invalid',
    });
  });

  it('rejects insecure SameSite=None cookies', () => {
    expect(
      () =>
        new OpaqueSessionService(new FakeSessions(), {
          sameSite: 'none',
          secureCookie: false,
        }),
    ).toThrow(expect.objectContaining({ code: 'identity.invalid_input' }));
  });

  it('sanitizes malformed session input', async () => {
    const service = new OpaqueSessionService(new FakeSessions());
    await expect(service.authenticate('too-short')).rejects.toBeInstanceOf(
      IdentityError,
    );
    await expect(
      service.issue(
        { userId, clientMetadata: { requestId: 'bad id' } },
        new CookieSink(),
      ),
    ).rejects.toMatchObject({
      code: 'identity.invalid_input',
    });
  });
});
