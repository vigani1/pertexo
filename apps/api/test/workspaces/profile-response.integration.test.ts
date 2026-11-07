import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'stored profile response boundary',
  () => {
    const api = useBetterAuthRealApi('profile_response');
    it('reports malformed stored profile data as a server failure and recovers after repair', async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      const browser = await api.signIn(email);
      await api
        .database()
        .query("update app.users set display_name='' where email=$1", [email]);
      const damaged = await api.send('GET', '/v1/users/me', { browser });
      expect(damaged.statusCode, damaged.payload).toBe(500);
      expect(damaged.json()).toMatchObject({ code: 'internal.unexpected' });
      expect(damaged.payload).not.toContain(email);
      await api
        .database()
        .query(
          "update app.users set display_name='Repaired profile' where email=$1",
          [email],
        );
      const repaired = await api.send('GET', '/v1/users/me', { browser });
      expect(repaired.statusCode, repaired.payload).toBe(200);
      expect(repaired.json()).toMatchObject({
        displayName: 'Repaired profile',
      });
    });
  },
);
