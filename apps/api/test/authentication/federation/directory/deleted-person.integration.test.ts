import { describe, expect, it } from 'vitest';

import {
  betterAuthIntegrationEnabled,
  browserFrom,
} from '../../../support/better-auth/real-api.support.js';
import { createDirectoryFixture } from './provisioning/fixture.js';

describe.skipIf(!betterAuthIntegrationEnabled)(
  'a person the directory deleted, on the real API and PostgreSQL',
  () => {
    const { setup, api, createPerson } = createDirectoryFixture();

    const sessions = async (email: string) => {
      const { rows } = await api.database().query<{ count: number }>(
        `select count(*)::integer count from app.auth_sessions session
         join app.users person on person.id=session.user_id where person.email=$1`,
        [email],
      );
      return rows[0]?.count;
    };

    async function provisioned(f: Awaited<ReturnType<typeof setup>>) {
      const email = `leaver@${f.domain}`;
      const created = await createPerson(f, email);
      expect(created.statusCode, created.payload).toBe(201);
      const directoryId = created.json<{ id: string }>().id;
      const signedIn = await api.finish(await api.start(f, api.person(email)));
      expect(signedIn.headers.location).not.toContain('ssoError');
      return { email, directoryId, browser: browserFrom(signedIn) };
    }

    const remove = (f: Awaited<ReturnType<typeof setup>>, id: string) =>
      api.send('DELETE', `${f.base}/Users/${id}`, { headers: f.headers });

    it('ends their sessions, refuses every sign-in after, and keeps refusing', async () => {
      const f = await setup();
      const { email, directoryId, browser } = await provisioned(f);
      await expect(
        api.send('GET', '/v1/users/me', { browser }),
      ).resolves.toMatchObject({ statusCode: 200 });

      const deleted = await remove(f, directoryId);
      expect(deleted.statusCode, deleted.payload).toBe(204);

      expect(
        (await api.send('GET', '/v1/users/me', { browser })).statusCode,
      ).toBe(401);
      expect(await sessions(email)).toBe(0);
      for (let attempt = 0; attempt < 2; attempt++) {
        const refused = await api.finish(await api.start(f, api.person(email)));
        expect(refused.headers.location).toContain('ssoError');
        expect(await sessions(email)).toBe(0);
      }
      const gone = await api.send('GET', `${f.base}/Users/${directoryId}`, {
        headers: f.headers,
      });
      expect(gone.statusCode).toBe(404);
      const { rows } = await api
        .database()
        .query<{ deleted: boolean }>(
          'select deleted_at is not null as deleted from app.auth_directory_users where id=$1',
          [directoryId],
        );
      expect(rows).toEqual([{ deleted: true }]);
    });

    it('lets the directory bring them back as a new record, and then they can sign in', async () => {
      const f = await setup();
      const { email, directoryId } = await provisioned(f);
      expect((await remove(f, directoryId)).statusCode).toBe(204);

      const recreated = await createPerson(f, email);
      expect(recreated.statusCode, recreated.payload).toBe(201);
      const replacementId = recreated.json<{ id: string }>().id;
      expect(replacementId).not.toBe(directoryId);

      const signedIn = await api.finish(await api.start(f, api.person(email)));
      expect(signedIn.headers.location).not.toContain('ssoError');
      expect(
        (
          await api.send('GET', '/v1/users/me', {
            browser: browserFrom(signedIn),
          })
        ).statusCode,
      ).toBe(200);

      expect((await remove(f, replacementId)).statusCode).toBe(204);
      const refused = await api.finish(await api.start(f, api.person(email)));
      expect(refused.headers.location).toContain('ssoError');
    });
  },
);
