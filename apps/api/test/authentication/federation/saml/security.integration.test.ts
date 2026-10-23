import { randomUUID } from 'node:crypto';
import { SAML_LIMITS } from '@pertexo/contracts';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
  expectProblem,
} from '../../../support/better-auth/real-api.support.js';
import { encryption, useSamlApi } from './api.fixture.js';
import { signingMaterial } from './fixture.js';

describe.skipIf(!betterAuthIntegrationEnabled)(
  'SAML journey authority and refusal through the real API',
  () => {
    const api = useSamlApi('saml_security');
    it('refuses missing browser proof, wrong correlation and forged claims without burning a valid journey', async () => {
      const fixture = await api.setup(),
        journey = await api.start(fixture);
      expect(
        (await api.finish(fixture, journey, {}, '')).headers.location,
      ).toContain('ssoError=true');
      expect(
        (await api.finish(fixture, journey, { requestId: '_unrequested' }))
          .headers.location,
      ).toContain('ssoError=true');
      expect(
        (
          await api.finish(fixture, journey, {
            responseIssuer: 'urn:wrong:idp',
          })
        ).headers.location,
      ).toContain('ssoError=true');
      expect(
        (
          await api.finish(fixture, journey, {
            email: 'outside@another.example.test',
          })
        ).headers.location,
      ).toContain('ssoError=true');
      expect(
        (
          await api
            .database()
            .query(
              "select id from app.users where lower(split_part(email,'@',2))=$1",
              [fixture.domain],
            )
        ).rowCount,
      ).toBe(1);
      const oversized = await api.send(
        'POST',
        '/v1/auth/federation/saml/callback',
        {
          headers: {
            cookie: journey.cookie,
            'content-type': 'application/x-www-form-urlencoded',
          },
          payload: new URLSearchParams({
            RelayState: journey.proof.state,
            SAMLResponse: 'A'.repeat(SAML_LIMITS.formBytes),
          }).toString(),
        },
      );
      expect(oversized.statusCode, oversized.payload).toBe(413);
      const result = await api.finish(fixture, journey);
      expect(result.headers.location).toContain('/account/security');
      expect((await api.finish(fixture, journey)).headers.location).toContain(
        'ssoError=true',
      );
      expect(
        (
          await api
            .database()
            .query(
              "select id from app.users where lower(split_part(email,'@',2))=$1",
              [fixture.domain],
            )
        ).rowCount,
      ).toBe(2);
    });
    it('refuses a revoked owner session and a changed provider during a readiness test', async () => {
      const fixture = await api.setup(),
        journey = await api.start(fixture, true);
      await api.send('POST', '/v1/auth/logout', {
        browser: fixture.owner,
        payload: {},
      });
      expect(
        (await api.send('GET', '/v1/users/me', { browser: fixture.owner }))
          .statusCode,
      ).toBe(401);
      expect((await api.finish(fixture, journey)).headers.location).toContain(
        'ssoTest=failed',
      );
      const current = {
        ...fixture,
        owner: await api.signIn(fixture.ownerEmail),
      };
      const pending = await api.start(current, true);
      await api.command({
        workspaceId: current.workspaceId,
        owner: current.owner,
        path: `/providers/${current.provider.id}`,
        payload: {
          kind: 'saml',
          name: 'Changed provider',
          configuration: current.provider.configuration,
          enabled: false,
          expectedRevision: 4,
        },
        method: 'PUT',
      });
      expect((await api.finish(current, pending)).headers.location).toContain(
        'ssoError=true',
      );
      expect(
        (
          await api
            .database()
            .query(
              'select provider_id from app.auth_provider_checks where provider_id=$1',
              [fixture.provider.id],
            )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await api
            .database()
            .query(
              "select id from app.users where lower(split_part(email,'@',2))=$1",
              [fixture.domain],
            )
        ).rowCount,
      ).toBe(1);
    });
    it('keeps metadata private, permits admin reads and refuses cross-protocol starts and admin writes', async () => {
      const fixture = await api.setup();
      const path = `/v1/workspaces/${fixture.workspaceId}/sso/saml/metadata`;
      expect((await api.send('GET', path)).statusCode).toBe(401);
      const invalid = await api.send(
        'PUT',
        `/v1/workspaces/${fixture.workspaceId}/sso/providers/${fixture.provider.id}`,
        {
          browser: fixture.owner,
          headers: { 'idempotency-key': randomUUID() },
          payload: {
            kind: 'saml',
            name: 'Malformed URL',
            configuration: {
              ...fixture.provider.configuration,
              signInUrl: 'https://',
            },
            enabled: true,
            expectedRevision: 4,
          },
        },
      );
      expectProblem(invalid, 400, 'request.invalid');

      const email = `admin-${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      const admin = await api.signIn(email);
      const user = (
        await api.send('GET', '/v1/users/me', { browser: admin })
      ).json<{ id: string }>();
      await api
        .database()
        .query(
          "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'admin','active')",
          [fixture.workspaceId, user.id],
        );
      expect((await api.send('GET', path, { browser: admin })).statusCode).toBe(
        200,
      );
      expectProblem(
        await api.send(
          'PUT',
          `/v1/workspaces/${fixture.workspaceId}/sso/providers/${fixture.provider.id}`,
          {
            browser: admin,
            headers: { 'idempotency-key': randomUUID() },
            payload: {
              kind: 'saml',
              name: 'Refused',
              configuration: fixture.provider.configuration,
              enabled: true,
              expectedRevision: 4,
            },
          },
        ),
        403,
        'auth.forbidden',
      );
      expect(
        (
          await api.send('POST', '/v1/auth/federation/oidc/start', {
            payload: {
              providerId: fixture.provider.id,
              domain: fixture.domain,
            },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await api
            .database()
            .query(
              'select id from app.auth_federation_attempts where provider_id=$1',
              [fixture.provider.id],
            )
        ).rowCount,
      ).toBe(0);
    });
  },
);

describe.skipIf(!betterAuthIntegrationEnabled)(
  'SAML development transport availability',
  () => {
    const api = useBetterAuthRealApi('saml_http', {
      federationEncryption: encryption,
    });
    it('explains HTTPS and secure-cookie requirements instead of saving an unusable provider', async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      const owner = await api.signIn(email);
      const workspace = await api.send('POST', '/v1/workspaces', {
        browser: owner,
        payload: { name: 'Local HTTP', slug: `local-${randomUUID()}` },
        headers: { 'idempotency-key': randomUUID() },
      });
      const workspaceId = workspace.json<{ id: string }>().id;
      const base = `/v1/workspaces/${workspaceId}/sso`;
      expect(
        (
          await api.send('POST', `${base}/organization`, {
            browser: owner,
            payload: { name: 'Local organization' },
            headers: { 'idempotency-key': randomUUID() },
          })
        ).statusCode,
      ).toBe(200);
      const response = await api.send('POST', `${base}/providers`, {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          kind: 'saml',
          name: 'Local SAML',
          issuer: 'urn:owned:idp',
          configuration: {
            signInUrl: 'https://idp.example.test/sso',
            certificates: [signingMaterial().certificate],
          },
          enabled: true,
          expectedRevision: 1,
        },
      });
      expectProblem(response, 400, 'request.invalid');
      expect(response.payload).toContain('HTTPS');
      const metadata = await api.send('GET', `${base}/saml/metadata`, {
        browser: owner,
      });
      expectProblem(metadata, 400, 'request.invalid');
      expect(metadata.payload).toContain('HTTPS');
      expect(
        (await api.database().query('select id from app.auth_providers'))
          .rowCount,
      ).toBe(0);
    });
  },
);
