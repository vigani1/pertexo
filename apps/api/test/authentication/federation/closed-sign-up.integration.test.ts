import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { betterAuthIntegrationEnabled } from '../../support/better-auth/real-api.support.js';
import { useSamlApi, samlOrigin } from './saml/api.fixture.js';
import { createSocialSignInFixture } from './social/fixture.js';

describe.skipIf(!betterAuthIntegrationEnabled)(
  'sign-in providers on an install with sign-up closed',
  () => {
    describe('social providers', () => {
      const { api, identity, start, finish } = createSocialSignInFixture({
        signUpMode: 'invitation',
      });

      async function users(email: string): Promise<number> {
        const rows = await api
          .database()
          .query<{ count: number }>(
            'select count(*)::int as count from app.users where email = $1',
            [email],
          );
        return rows.rows[0]?.count ?? 0;
      }

      async function ownerWorkspace() {
        const email = `owner-${randomUUID()}@example.test`;
        await api.signUp(email, '/login?verified=true');
        const browser = await api.signIn(email);
        const created = await api.send('POST', '/v1/workspaces', {
          browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { name: 'Owner', slug: `own-${randomUUID().slice(0, 8)}` },
        });
        expect(created.statusCode, created.payload).toBe(201);
        return { browser, workspaceId: created.json<{ id: string }>().id };
      }

      // docs-deps-product-01: "Sign in with Google" would otherwise reopen sign-up.
      it.fails(
        'refuses a provider proof for an address no one invited',
        async () => {
          await ownerWorkspace();
          const proof = identity();

          const reply = await finish(await start(proof));

          expect(reply.headers.location).toContain('/login?socialError=true');
          expect(await users(proof.email ?? '')).toBe(0);
        },
      );

      it('lets an invited address arrive through a provider', async () => {
        const { browser, workspaceId } = await ownerWorkspace();
        const proof = identity();
        const invited = await api.send(
          'POST',
          `/v1/workspaces/${workspaceId}/invitations`,
          {
            browser,
            headers: { 'idempotency-key': randomUUID() },
            payload: { email: proof.email, role: 'builder' },
          },
        );
        expect(invited.statusCode, invited.payload).toBe(202);

        const reply = await finish(await start(proof));

        expect(reply.headers.location).not.toContain('socialError');
        expect(await users(proof.email ?? '')).toBe(1);
      });
    });

    describe('organization SSO', () => {
      const api = useSamlApi('closed_sign_up', { signUpMode: 'invitation' });

      it('still creates the account of someone on a verified domain', async () => {
        const fixture = await api.setup();
        const test = await api.start(fixture, true);
        expect((await api.finish(fixture, test)).headers.location).toContain(
          'ssoTest=passed',
        );

        const reply = await api.finish(fixture, await api.start(fixture));

        expect(reply.statusCode, reply.payload).toBe(302);
        expect(reply.headers.location).toBe(`${samlOrigin}/account/security`);
        const created = await api
          .database()
          .query<{ id: string }>('select id from app.users where email = $1', [
            `person@${fixture.domain}`,
          ]);
        expect(created.rowCount).toBe(1);
      });
    });
  },
);
