import { randomUUID } from 'node:crypto';

import { generatePersistedId } from '@pertexo/database/platform';
import { describe, expect, it } from 'vitest';

import {
  betterAuthIntegrationEnabled,
  browserFrom,
  type Browser,
} from '../../../support/better-auth/real-api.support.js';
import { useOrganizationApi } from './fixture.js';

/**
 * A session issued outside Better Auth has a time-ordered id, part of which can
 * be guessed. That's fine only if the id authorizes nothing: the opaque token
 * is the credential, and an id acts only for the person who owns the session.
 */
describe.skipIf(!betterAuthIntegrationEnabled)(
  'the id of a session issued by a provider',
  () => {
    const api = useOrganizationApi('session_ids');

    const revoke = (browser: Browser, sessionId: string) =>
      api.send('POST', '/v1/auth/account-security/sessions/revoke', {
        browser,
        headers: { 'x-csrf-token': browser.csrf },
        payload: { sessionId },
      });
    const alive = async (browser: Browser) =>
      (await api.send('GET', '/v1/users/me', { browser })).statusCode === 200;

    async function signedIn(
      f: Awaited<ReturnType<typeof api.setup>>,
      email: string,
    ) {
      const reply = await api.finish(await api.start(f, api.person(email)));
      expect(reply.headers.location).not.toContain('ssoError');
      return browserFrom(reply);
    }

    async function storedSessions(email: string) {
      const { rows } = await api.database().query<{
        id: string;
        token: string;
      }>(
        `select session.id,session.token from app.auth_sessions session
         join app.users person on person.id=session.user_id
         where person.email=$1 order by session.created_at`,
        [email],
      );
      return rows;
    }

    it('keeps the credential in a token that shares nothing with the id', async () => {
      const f = await api.setup();
      const email = `person-${randomUUID().slice(0, 8)}@${f.domain}`;
      await signedIn(f, email);
      const [session] = await storedSessions(email);
      if (session === undefined) throw new Error('Session missing');
      expect(session.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/u);
      expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(session.token).not.toContain(session.id);
      expect(session.token).not.toContain(session.id.replaceAll('-', ''));
    });

    it("can't be used by someone else to end a session, even knowing the id", async () => {
      const f = await api.setup();
      const email = `target-${randomUUID().slice(0, 8)}@${f.domain}`;
      const target = await signedIn(f, email);
      const [session] = await storedSessions(email);
      if (session === undefined) throw new Error('Session missing');

      const attacker = await signedIn(
        f,
        `attacker-${randomUUID().slice(0, 8)}@${f.domain}`,
      );
      const attempt = await revoke(attacker, session.id);

      expect(attempt.json()).toEqual({ revoked: false });
      await expect(alive(target)).resolves.toBe(true);
    });

    it("won't stand in for the token in a session cookie", async () => {
      const f = await api.setup();
      const email = `cookie-${randomUUID().slice(0, 8)}@${f.domain}`;
      const browser = await signedIn(f, email);
      const [session] = await storedSessions(email);
      if (session === undefined) throw new Error('Session missing');

      const forged = {
        ...browser,
        cookie: browser.cookie.replace(
          /(pertexo_session=)[^;]+/u,
          `$1${session.id}`,
        ),
      };
      expect(forged.cookie).not.toBe(browser.cookie);
      expect(
        (await api.send('GET', '/v1/users/me', { browser: forged })).statusCode,
      ).toBe(401);
    });

    it('is still accepted where its owner names it, so nothing relied on the old form', async () => {
      const f = await api.setup();
      const email = `owner-${randomUUID().slice(0, 8)}@${f.domain}`;
      const current = await signedIn(f, email);
      const otherId = generatePersistedId();
      await api.database().query(
        `insert into app.auth_sessions(id,expires_at,token,user_id)
         select $1,clock_timestamp()+interval '1 hour',$2,id from app.users where email=$3`,
        [otherId, randomUUID(), email],
      );

      const reply = await revoke(current, otherId);

      expect(reply.json()).toEqual({ revoked: true });
      expect((await storedSessions(email)).map(({ id }) => id)).not.toContain(
        otherId,
      );
      await expect(alive(current)).resolves.toBe(true);
    });
  },
);
