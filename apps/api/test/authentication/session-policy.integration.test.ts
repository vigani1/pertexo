import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseApiConfig } from '../../src/platform/config/api-config.js';
import { standaloneBetterAuthEnvironment } from '../config/fixture.js';
import {
  betterAuthIntegrationEnabled,
  browserFrom,
  useBetterAuthRealApi,
  type Reply,
} from '../support/better-auth/real-api.support.js';
import { password } from '../support/better-auth/api/environment.js';

for (const [sameSite, ttlMillis] of [
  ['strict', 60_000],
  ['lax', 3_600_000],
  ['none', 1_000],
] as const) {
  describe.runIf(betterAuthIntegrationEnabled)(
    `issued ${sameSite} session policy`,
    () => {
      const session = parseApiConfig({
        ...standaloneBetterAuthEnvironment(),
        NODE_ENV: 'test',
        SESSION_COOKIE_SAME_SITE: sameSite,
        SESSION_TTL_MILLIS: String(ttlMillis),
      }).identity?.session;
      if (session === undefined)
        throw new Error('Fixture session policy missing');
      const api = useBetterAuthRealApi(`policy_${sameSite}`, { session });
      function assertCookies(reply: Reply) {
        const raw = reply.headers['set-cookie'];
        const cookies = typeof raw === 'string' ? [raw] : (raw ?? []);
        for (const name of ['pertexo_session', 'pertexo_csrf']) {
          const cookie = cookies.find((value) => value.startsWith(`${name}=`));
          expect(cookie).toBeDefined();
          expect(cookie?.toLowerCase()).toContain(`samesite=${sameSite}`);
          expect(cookie).toContain(`Max-Age=${ttlMillis / 1_000}`);
          expect(cookie).toContain('Secure');
        }
      }
      it('uses the parsed policy for issued and replacement cookies and the stored expiry', async () => {
        const email = `${randomUUID()}@example.test`;
        await api.signUp(email, '/workspaces');
        const signed = await api.send('POST', '/v1/auth/sign-in/email', {
          payload: { email, password },
        });
        expect(signed.statusCode, signed.payload).toBe(200);
        assertCookies(signed);
        const stored = await api
          .database()
          .query<{ lifetime: number }>(
            `select extract(epoch from (s.expires_at-s.created_at))*1000 lifetime from app.auth_sessions s join app.users u on u.id=s.user_id where u.email=$1`,
            [email],
          );
        expect(stored.rows).toHaveLength(1);
        expect(
          Math.abs(Number(stored.rows[0]?.lifetime) - ttlMillis),
        ).toBeLessThan(1_000);
        const replacement = await api.send(
          'POST',
          '/v1/auth/account-security/password/change',
          {
            browser: browserFrom(signed),
            payload: {
              currentPassword: password,
              newPassword: 'a replacement integration password',
            },
          },
        );
        expect(replacement.statusCode, replacement.payload).toBe(200);
        assertCookies(replacement);
        const successor = await api
          .database()
          .query<{ lifetime: number }>(
            `select extract(epoch from (s.expires_at-s.created_at))*1000 lifetime from app.auth_sessions s join app.users u on u.id=s.user_id where u.email=$1`,
            [email],
          );
        expect(successor.rows).toHaveLength(1);
        expect(Number(successor.rows[0]?.lifetime)).toBeGreaterThan(0);
        expect(Number(successor.rows[0]?.lifetime)).toBeLessThanOrEqual(
          ttlMillis,
        );
      });
    },
  );
}

describe('session lifetime boundary', () => {
  it.each(['1', '999', '1001', '0', '-1000'])(
    'refuses unsupported SESSION_TTL_MILLIS=%s with its setting name',
    (value) => {
      expect(() =>
        parseApiConfig({
          ...standaloneBetterAuthEnvironment(),
          SESSION_TTL_MILLIS: value,
        }),
      ).toThrow(/SESSION_TTL_MILLIS/u);
    },
  );
});
