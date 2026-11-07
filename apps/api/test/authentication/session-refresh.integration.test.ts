import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  browserFrom,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

for (const sameSite of ['lax', 'strict', 'none'] as const) {
  describe.runIf(betterAuthIntegrationEnabled)(
    `explicit ${sameSite} session refresh`,
    () => {
      const api = useBetterAuthRealApi(`refresh_${sameSite}`, {
        session: { ttlMillis: 60_000, secureCookie: true, sameSite },
      });

      it('refreshes a still-valid aged session with the configured cookie policy and usable credentials', async () => {
        const email = `${randomUUID()}@example.test`;
        await api.signUp(email, '/workspaces');
        const browser = await api.signIn(email);
        const aged = await api
          .database()
          .query<{ id: string; expires_at: Date }>(
            `update app.auth_sessions set
           created_at=clock_timestamp()-interval '40 seconds',
           updated_at=clock_timestamp()-interval '40 seconds',
           expires_at=clock_timestamp()+interval '20 seconds'
         where user_id=(select id from app.users where email=$1)
         returning id, expires_at`,
            [email],
          );
        expect(aged.rows).toHaveLength(1);
        const response = await api.send('GET', '/v1/auth/account-security', {
          browser,
        });
        expect(response.statusCode, response.payload).toBe(200);
        const saved = await api
          .database()
          .query<{ id: string; expires_at: Date }>(
            'select id, expires_at from app.auth_sessions',
          );
        expect(saved.rows).toHaveLength(1);
        expect(saved.rows[0]?.id).toBe(aged.rows[0]?.id);
        expect(
          Number(saved.rows[0]?.expires_at) - Number(aged.rows[0]?.expires_at),
        ).toBeGreaterThan(30_000);
        const raw = response.headers['set-cookie'];
        const cookies = typeof raw === 'string' ? [raw] : (raw ?? []);
        const refreshed = cookies.filter((cookie) =>
          cookie.startsWith('pertexo_session='),
        );
        expect(refreshed).toHaveLength(1);
        expect(refreshed[0]?.toLowerCase()).toMatch(
          new RegExp(`;\\s*samesite=${sameSite}(?:;|$)`, 'u'),
        );
        expect(refreshed[0]).toMatch(/;\s*Secure(?:;|$)/iu);
        expect(refreshed[0]).toMatch(/;\s*Max-Age=60(?:;|$)/iu);
        expect(
          (
            await api.send('GET', '/v1/users/me', {
              browser: browserFrom(response),
            })
          ).statusCode,
        ).toBe(200);
      });
    },
  );
}
