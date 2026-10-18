import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  browserFrom,
  expectProblem,
} from '../../../support/better-auth/real-api.support.js';
import { useSamlApi, samlOrigin } from './api.fixture.js';

describe.skipIf(!betterAuthIntegrationEnabled)(
  'signed organization SAML through the real API',
  () => {
    const api = useSamlApi('saml_signin');
    it('tests an off provider without a Lax session cookie and grants no account or membership', async () => {
      const fixture = await api.setup(false),
        journey = await api.start(fixture, true);
      expect(journey.response.headers['set-cookie']).toEqual(
        expect.arrayContaining([expect.stringContaining('SameSite=None')]),
      );
      const reply = await api.finish(fixture, journey);
      expect(reply.statusCode, reply.payload).toBe(302);
      expect(reply.headers.location).toBe(
        `${samlOrigin}/w/${fixture.workspaceId}/settings/sso?ssoTest=passed`,
      );
      expect(reply.headers['set-cookie']).toBeUndefined();
      const counts = await api.database().query<{
        users: number;
        members: number;
        checks: number;
      }>(`select
      (select count(*)::int from app.users) users,
      (select count(*)::int from app.workspace_memberships) members,
      (select count(*)::int from app.auth_provider_checks) checks`);
      expect(counts.rows).toEqual([{ users: 1, members: 1, checks: 1 }]);
      expect(
        (await api.send('GET', '/v1/users/me', { browser: fixture.owner }))
          .statusCode,
      ).toBe(200);
      const metadata = await api.send(
        'GET',
        `/v1/workspaces/${fixture.workspaceId}/sso/saml/metadata`,
        { browser: fixture.owner },
      );
      expect(metadata.statusCode, metadata.payload).toBe(200);
      expect(metadata.headers['content-type']).toContain('application/json');
      expect(metadata.payload).toContain(
        `/organizations/${fixture.organizationId}`,
      );
      expect(metadata.payload).toContain('/v1/auth/federation/saml/callback');
    });
    it('creates a verified JIT identity once across two API runtimes and preserves required-SSO proof', async () => {
      const fixture = await api.setup(),
        test = await api.start(fixture, true);
      expect((await api.finish(fixture, test)).headers.location).toContain(
        'ssoTest=passed',
      );
      await api.command(
        fixture.workspaceId,
        fixture.owner,
        `/domains/${fixture.domainId}/enforcement`,
        { required: true, expectedRevision: 4 },
        'PUT',
      );
      const journey = await api.start(fixture),
        peer = await api.createIdentityPeer(api.encryption);
      const body = api.form(fixture, journey);
      const other = peer.betterAuth.auth.handler(
        new Request(`${samlOrigin}/v1/auth/federation/saml/callback`, {
          method: 'POST',
          headers: {
            cookie: journey.cookie,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body,
        }),
      );
      const primary = api.send('POST', '/v1/auth/federation/saml/callback', {
        headers: {
          cookie: journey.cookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: body,
      });
      const [first, second] = await Promise.all([primary, other]);
      const locations = [
        String(first.headers.location),
        second.headers.get('location'),
      ];
      expect(
        locations.filter(
          (location) => location === `${samlOrigin}/account/security`,
        ),
      ).toHaveLength(1);
      expect(
        locations.filter((location) => location?.includes('ssoError=true')),
      ).toHaveLength(1);
      const created = await api
        .database()
        .query<{ id: string }>('select id from app.users where email=$1', [
          `person@${fixture.domain}`,
        ]);
      expect(created.rowCount).toBe(1);
      const identityId = created.rows[0]?.id;
      const membership = await api
        .database()
        .query<{ role: string }>(
          'select role from app.workspace_memberships where user_id=$1 and workspace_id=$2',
          [identityId, fixture.workspaceId],
        );
      expect(membership.rows).toEqual([{ role: 'viewer' }]);
      const sessions = await api.database().query<{
        authentication_method: string;
        federation_provider_id: string;
      }>('select authentication_method,federation_provider_id from app.auth_sessions where user_id=$1', [identityId]);
      expect(sessions.rows).toEqual([
        {
          authentication_method: 'organization',
          federation_provider_id: fixture.provider.id,
        },
      ]);
      const identities = await api
        .database()
        .query('select id from app.auth_accounts where user_id=$1', [
          identityId,
        ]);
      expect(identities.rowCount).toBe(1);
      const audit = await api
        .database()
        .query(
          'select id from app.audit_events where workspace_id=$1 and action=$2',
          [fixture.workspaceId, 'identity.session_signed_in'],
        );
      expect(audit.rowCount).toBe(1);
    });
    it('delivers a normal SAML session, refuses password bypass and retains its provider through account maintenance', async () => {
      const fixture = await api.setup();
      const tested = await api.start(fixture, true);
      expect((await api.finish(fixture, tested)).headers.location).toContain(
        'ssoTest=passed',
      );
      await api.command(
        fixture.workspaceId,
        fixture.owner,
        `/domains/${fixture.domainId}/enforcement`,
        { required: true, expectedRevision: 4 },
        'PUT',
      );
      const reply = await api.finish(fixture, await api.start(fixture));
      const browser = browserFrom(reply),
        password = 'another secure integration password';
      expect(
        (await api.send('GET', '/v1/users/me', { browser })).statusCode,
      ).toBe(200);
      const setup = await api.send(
        'POST',
        '/v1/auth/account-security/password/setup',
        { browser, payload: { newPassword: password } },
      );
      expect(setup.statusCode, setup.payload).toBe(200);
      const current = browserFrom(setup);
      expect(
        (await api.send('GET', '/v1/users/me', { browser: current }))
          .statusCode,
      ).toBe(200);
      expectProblem(
        await api.send('POST', '/v1/auth/sign-in/email', {
          payload: { email: `person@${fixture.domain}`, password },
        }),
        403,
        'auth.sso_required',
      );
      const sessions = await api
        .database()
        .query<{ authentication_method: string }>(
          'select authentication_method from app.auth_sessions where user_id=(select id from app.users where email=$1)',
          [`person@${fixture.domain}`],
        );
      expect(sessions.rows).toEqual([
        { authentication_method: 'organization' },
      ]);
      const recovery = await api.signIn(fixture.ownerEmail);
      expect(
        (await api.send('GET', '/v1/users/me', { browser: recovery }))
          .statusCode,
      ).toBe(200);
    });
  },
);
