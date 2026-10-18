import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  browserFrom,
  expectProblem,
  origin,
} from '../../../support/better-auth/real-api.support.js';
import { useOrganizationApi, encryption } from './fixture.js';

describe.skipIf(!betterAuthIntegrationEnabled)(
  'organization OIDC on the real API',
  () => {
    const api = useOrganizationApi('organization');
    it('keeps owner readiness tests bound to the owner without creating users, accounts, grants or sessions', async () => {
      const setup = await api.setup();
      const before = await api
        .database()
        .query(
          'select (select count(*) from app.users) users,(select count(*) from app.auth_accounts) accounts,(select count(*) from app.workspace_memberships) memberships,(select count(*) from app.auth_sessions) sessions',
        );
      await api.ready(setup);
      const after = await api
        .database()
        .query(
          'select (select count(*) from app.users) users,(select count(*) from app.auth_accounts) accounts,(select count(*) from app.workspace_memberships) memberships,(select count(*) from app.auth_sessions) sessions',
        );
      expect(after.rows).toEqual(before.rows);
      const settings = await api.send(
        'GET',
        `/v1/workspaces/${setup.workspaceId}/sso`,
        { browser: setup.owner },
      );
      expect(settings.statusCode).toBe(200);
      expect(settings.payload).not.toContain('private-provider-secret');
      expect(settings.payload).not.toContain('ciphertext');
      expect(settings.json()).toMatchObject({
        organization: {
          domains: [
            { checks: [{ providerId: setup.providerId, providerRevision: 1 }] },
          ],
        },
      });
      const failed = await api.start(
        setup,
        api.person(`tester@${setup.domain}`),
        { ...setup, owner: setup.owner },
      );
      expect(
        (
          await api.finish(
            failed,
            failed.cookie.slice(
              failed.cookie.indexOf('pertexo_organization_signin='),
            ),
          )
        ).headers.location,
      ).toContain('ssoTest=failed');
    });
    it('requires the browser binding and exact verified domain before JIT membership, with one successful callback across API instances', async () => {
      const setup = await api.setup();
      const email = `member@${setup.domain}`;
      const journey = await api.start(setup, api.person(email));
      expect((await api.finish(journey, '')).headers.location).toContain(
        'ssoError=true',
      );
      const peer = await api.createIdentityPeer(encryption);
      const replies = await Promise.all([
        api.finish(journey),
        peer.betterAuth.auth.handler(
          new Request(origin + journey.callback, {
            headers: { cookie: journey.cookie },
          }),
        ),
      ]);
      const locations = [
        replies[0].headers.location,
        replies[1].headers.get('location'),
      ];
      expect(
        locations.filter(
          (location) => location === `${origin}/account/security`,
        ),
      ).toHaveLength(1);
      expect((await api.finish(journey)).headers.location).toContain(
        'ssoError=true',
      );
      expect(
        (
          await api
            .database()
            .query(
              'select membership.role,membership.status,session.authentication_method,session.federation_provider_id from app.users users join app.workspace_memberships membership on membership.user_id=users.id join app.auth_sessions session on session.user_id=users.id where users.email=$1',
              [email],
            )
        ).rows,
      ).toEqual([
        {
          role: 'viewer',
          status: 'active',
          authentication_method: 'organization',
          federation_provider_id: setup.providerId,
        },
      ]);
      const outside = `outside-${randomUUID()}@unclaimed.test`;
      expect(
        (await api.finish(await api.start(setup, api.person(outside)))).headers
          .location,
      ).toContain('ssoError=true');
      expect(
        (
          await api
            .database()
            .query('select id from app.users where email=$1', [outside])
        ).rowCount,
      ).toBe(0);
    });
    it('blocks password, old sessions and email changes under required SSO while allowing the organization proof', async () => {
      const setup = await api.setup();
      const email = `member@${setup.domain}`;
      await api.signUp(email, '/workspaces');
      const old = await api.signIn(email);
      await api.ready(setup);
      await api.enforce(setup);
      expectProblem(
        await api.send('POST', '/v1/auth/sign-in/email', {
          payload: { email, password: 'a long enough integration password' },
        }),
        403,
        'auth.sso_required',
      );
      expect(
        (await api.send('GET', '/v1/users/me', { browser: old })).statusCode,
      ).toBe(401);
      const current = browserFrom(
        await api.finish(await api.start(setup, api.person(email))),
      );
      expect(
        (await api.send('GET', '/v1/users/me', { browser: current }))
          .statusCode,
      ).toBe(200);
      expectProblem(
        await api.send('POST', '/v1/auth/change-email', {
          browser: current,
          payload: {
            newEmail: `outside-${randomUUID()}@example.test`,
            callbackURL: '/account/security',
          },
        }),
        403,
        'auth.organization_email_managed',
      );
      const change = await api.send(
        'POST',
        '/v1/auth/account-security/password/change',
        {
          browser: current,
          payload: {
            currentPassword: 'a long enough integration password',
            newPassword: 'a different long integration password',
          },
        },
      );
      expect(change.statusCode, change.payload).toBe(200);
      const rotated = browserFrom(change);
      expect(
        (await api.send('GET', '/v1/users/me', { browser: rotated }))
          .statusCode,
      ).toBe(200);
      expect(
        (
          await api
            .database()
            .query(
              'select distinct authentication_method from app.auth_sessions session join app.users users on users.id=session.user_id where users.email=$1',
              [email],
            )
        ).rows,
      ).toEqual([{ authentication_method: 'organization' }]);
    });
    it('retains a working break-glass owner password and audits its use', async () => {
      const setup = await api.setup(true);
      await api.ready(setup);
      await api.enforce(setup);
      const recovered = await api.signIn(setup.ownerEmail);
      expect(
        (await api.send('GET', '/v1/users/me', { browser: recovered }))
          .statusCode,
      ).toBe(200);
      expect(
        (
          await api
            .database()
            .query(
              "select action from app.audit_events where workspace_id=$1 and action='identity.recovery_authorized'",
              [setup.workspaceId],
            )
        ).rows,
      ).toHaveLength(1);
      const current = browserFrom(
        await api.finish(await api.start(setup, api.person(setup.ownerEmail))),
      );
      const method = (
        await api.send('GET', '/v1/auth/account-security', { browser: current })
      )
        .json<{ methods: { id: string; kind: string }[] }>()
        .methods.find((entry) => entry.kind === 'password');
      if (method === undefined) throw new Error('Recovery password missing');
      expectProblem(
        await api.send('POST', '/v1/auth/account-security/methods/unlink', {
          browser: current,
          payload: { methodId: method.id },
        }),
        403,
        'auth.recovery_required',
      );
    });
    it('refuses wrong or missing master keys at startup and accepts a retained previous key', async () => {
      await api.setup();
      const wrong = {
        current: {
          version: 'organization-v1',
          key: Buffer.alloc(32, 0x39).toString('base64'),
        },
        previous: [],
      };
      for (const keys of [undefined, wrong])
        await expect(api.createIdentityPeer(keys)).rejects.toThrow(
          'Organization sign-in secrets cannot be opened',
        );
      await expect(
        api.createIdentityPeer({
          current: {
            version: 'organization-v2',
            key: Buffer.alloc(32, 0x29).toString('base64'),
          },
          previous: [encryption.current],
        }),
      ).resolves.toHaveProperty('betterAuth');
    });
    it('reports provider outages as unavailable and rejects owner tests without CSRF', async () => {
      const setup = await api.setup();
      const spy = vi
        .spyOn(api.gateway, 'authorize')
        .mockRejectedValueOnce(new Error('secret provider response'));
      try {
        const reply = await api.send('POST', '/v1/auth/federation/oidc/start', {
          payload: { providerId: setup.providerId, domain: setup.domain },
        });
        expect(reply.statusCode).toBe(503);
        expect(reply.payload).not.toContain('secret provider response');
      } finally {
        spy.mockRestore();
      }
      const refused = await api.send('POST', '/v1/auth/federation/oidc/test', {
        headers: { cookie: setup.owner.cookie },
        payload: {
          workspaceId: setup.workspaceId,
          providerId: setup.providerId,
          domainId: setup.domainId,
        },
      });
      expect(refused.statusCode).toBe(403);
    });
  },
);
