import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

// An address stored before the 254-character bound on new addresses: the
// users column allows 320, so such accounts may exist.
const stored = (tag: string) =>
  `${tag}${'a'.repeat(64 - tag.length)}@${['b'.repeat(63), 'c'.repeat(63), 'd'.repeat(63)].join('.')}.example`;

describe.runIf(betterAuthIntegrationEnabled)(
  'an existing account with a stored address longer than 254 characters',
  () => {
    const api = useBetterAuthRealApi('stored_long_email');

    it('is sent a password reset', async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/login?verified=true');
      const long = stored(randomUUID().slice(0, 8));
      expect(long).toHaveLength(264);
      await api
        .database()
        .query('update app.users set email=$1 where email=$2', [long, email]);
      const reply = await api.send('POST', '/v1/auth/request-password-reset', {
        payload: { email: long, redirectTo: '/reset-password' },
      });
      expect(reply.statusCode, reply.payload).toBe(200);
      const proofs = await api
        .database()
        .query<{ count: number }>(
          "select count(*)::int count from app.auth_verifications where value=(select id::text from app.users where email=$1) and identifier like 'reset-password:%'",
          [long],
        );
      expect(proofs.rows[0]?.count).toBe(1);
    });
  },
);
