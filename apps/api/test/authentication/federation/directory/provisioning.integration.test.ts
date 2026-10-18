import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  workspaceMembersResponseSchema,
  directoryCredentialResultSchema,
  directorySettingsSchema,
} from '@pertexo/contracts';
import {
  betterAuthIntegrationEnabled,
  browserFrom,
} from '../../../support/better-auth/real-api.support.js';
import { useOrganizationApi, encryption } from '../organization/fixture.js';
import { registerDirectoryTransport } from '../../../../src/authentication/federation/provisioning/transport/register.js';

const coreUser = 'urn:ietf:params:scim:schemas:core:2.0:User';
const coreGroup = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const patch = (Operations: unknown[]) => ({
  schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
  Operations,
});

describe.skipIf(!betterAuthIntegrationEnabled)(
  'SCIM on the real API and PostgreSQL',
  () => {
    const api = useOrganizationApi('directory');
    async function setup() {
      const f = await api.setup();
      const organization = f.settings.organization;
      if (organization === null) throw new Error('Organization missing');
      const response = await api.send(
        'POST',
        `/v1/workspaces/${f.workspaceId}/sso/directory/credentials`,
        {
          browser: f.owner,
          headers: { 'idempotency-key': randomUUID() },
          payload: {
            name: 'Provisioning fixture',
            expectedRevision: organization.revision,
          },
        },
      );
      expect(response.statusCode, response.payload).toBe(200);
      const credential = directoryCredentialResultSchema.parse(response.json());
      if (credential.replayed) throw new Error('Fresh credential replayed');
      const headers = {
        authorization: `Bearer ${credential.secret}`,
        'content-type': 'application/scim+json',
        origin: 'https://machine.integration.test',
      };
      const base = `/v1/auth/federation/scim/${organization.id}/v2`;
      return { ...f, credential, headers, base };
    }
    const createPerson = (
      f: Awaited<ReturnType<typeof setup>>,
      email: string,
    ) =>
      api.send('POST', `${f.base}/Users`, {
        headers: f.headers,
        payload: {
          schemas: [coreUser],
          userName: email,
          active: true,
          emails: [{ value: email, primary: true }],
        },
      });

    it('fails closed before database authentication and enforces the shared workspace bucket even on discovery', async () => {
      const f = await setup(),
        store = api.identity().directory;
      for (const mode of ['pre', 'post', 'backend'] as const) {
        const transport = Fastify(),
          authenticated = vi.spyOn(store, 'authenticate');
        try {
          registerDirectoryTransport(transport, {
            store,
            publicOrigin: 'https://app.integration.test',
            rateLimitConsumer: {
              consume: (decision) => {
                if (mode === 'backend')
                  return Promise.reject(
                    new Error('Unavailable rate-limit backend'),
                  );
                if (
                  mode === 'pre' ||
                  decision.endpointClass === 'directory_provisioning'
                ) {
                  if (mode === 'post')
                    expect(decision.dimensions).toEqual([
                      {
                        kind: 'workspace',
                        identifier: f.workspaceId,
                        limit: 300,
                      },
                    ]);
                  return Promise.resolve({
                    allowed: false,
                    retryAfterSeconds: 2,
                    limitedDimension:
                      mode === 'pre' ? 'client_address' : 'workspace',
                  });
                }
                return Promise.resolve({ allowed: true });
              },
            },
          });
          for (const method of [
            'GET',
            'POST',
            'PUT',
            'PATCH',
            'DELETE',
          ] as const) {
            authenticated.mockClear();
            const reply = await transport.inject({
              method,
              url: `${f.base}/${method === 'GET' ? 'ServiceProviderConfig' : 'Users'}`,
              headers: f.headers,
              ...(method === 'GET' || method === 'DELETE'
                ? {}
                : { payload: {} }),
            });
            expect(reply.statusCode).toBe(mode === 'backend' ? 503 : 429);
            expect(reply.headers['content-type']).toContain(
              'application/scim+json',
            );
            expect(authenticated).toHaveBeenCalledTimes(
              mode === 'post' ? 1 : 0,
            );
          }
        } finally {
          authenticated.mockRestore();
          await transport.close();
        }
      }
    });

    it('authenticates discovery, publishes supported schemas, and preserves safe protocol errors before Nest dispatch', async () => {
      const f = await setup();
      const unauthorized = await api.send('GET', `${f.base}/Schemas`);
      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.headers['content-type']).toContain(
        'application/scim+json',
      );
      const discovery = await api.send(
        'GET',
        `${f.base}/ServiceProviderConfig`,
        { headers: f.headers },
      );
      expect(discovery.statusCode).toBe(200);
      expect(discovery.json()).toMatchObject({
        patch: { supported: true },
        bulk: { supported: false },
        filter: { supported: true, maxResults: 100 },
      });
      const schemas = await api.send('GET', `${f.base}/Schemas`, {
        headers: f.headers,
      });
      expect(schemas.statusCode, schemas.payload).toBe(200);
      expect(schemas.payload).not.toContain('password');
      expect(schemas.payload).not.toContain(f.credential.secret);
      const malformed = await api.send('POST', `${f.base}/Users`, {
        headers: f.headers,
        payload: '{"secret":"never-log-this",',
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.payload).not.toContain('never-log-this');
      expect(malformed.headers['content-type']).toContain(
        'application/scim+json',
      );
      const oversized = await api.send('POST', `${f.base}/Users`, {
        headers: f.headers,
        payload: ' '.repeat(1024 * 1024 + 1),
      });
      expect(oversized.statusCode).toBe(413);
      expect(oversized.headers['content-type']).toContain(
        'application/scim+json',
      );
      const wrongMedia = await api.send('POST', `${f.base}/Users`, {
        headers: { ...f.headers, 'content-type': 'text/plain' },
        payload: 'unsupported',
      });
      expect([400, 415]).toContain(wrongMedia.statusCode);
      expect(wrongMedia.headers['content-type']).toContain(
        'application/scim+json',
      );
    });

    it('accepts Entra-shaped Users/Groups, applies filtered PATCH atomically and uses one-winner If-Match', async () => {
      const f = await setup(),
        email = `directory@${f.domain}`;
      const created = await createPerson(f, email);
      expect(created.statusCode, created.payload).toBe(201);
      const user = created.json<{ id: string }>();
      const filtered = await api.send(
        'GET',
        `${f.base}/Users?filter=${encodeURIComponent(`userName eq "${email.toUpperCase()}"`)}&attributes=id,userName`,
        { headers: f.headers },
      );
      expect(filtered.json()).toMatchObject({
        totalResults: 1,
        Resources: [{ id: user.id, userName: email }],
      });
      expect(filtered.payload).not.toContain('emails');
      const group = await api.send('POST', `${f.base}/Groups`, {
        headers: f.headers,
        payload: {
          schemas: [coreGroup],
          displayName: 'Builders',
          members: [{ value: user.id }],
        },
      });
      expect(group.statusCode, group.payload).toBe(201);
      const current = await api.send('GET', `${f.base}/Users/${user.id}`, {
        headers: f.headers,
      });
      const etag = String(current.headers.etag);
      const changes = await Promise.all(
        [false, true].map((active) =>
          api.send('PATCH', `${f.base}/Users/${user.id}`, {
            headers: { ...f.headers, 'if-match': etag },
            payload: patch([{ op: 'Replace', value: { active } }]),
          }),
        ),
      );
      expect(changes.map((response) => response.statusCode).sort()).toEqual([
        200, 412,
      ]);
      const lateFailure = await api.send(
        'PATCH',
        `${f.base}/Users/${user.id}`,
        {
          headers: f.headers,
          payload: patch([
            { op: 'replace', path: 'displayName', value: 'Should roll back' },
            {
              op: 'replace',
              path: 'emails[value eq "missing"].value',
              value: 'other@example.test',
            },
          ]),
        },
      );
      expect(lateFailure.statusCode).toBe(400);
      expect(
        (
          await api.send('GET', `${f.base}/Users/${user.id}`, {
            headers: f.headers,
          })
        ).payload,
      ).not.toContain('Should roll back');
      const duplicate = await createPerson(f, email);
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({ scimType: 'uniqueness' });
      const deletion = await api.send('DELETE', `${f.base}/Users/${user.id}`, {
        headers: f.headers,
      });
      expect(deletion.statusCode).toBe(204);
      expect(
        (
          await api.send('GET', `${f.base}/Users/${user.id}`, {
            headers: f.headers,
          })
        ).statusCode,
      ).toBe(404);
      expect((await createPerson(f, email)).statusCode).toBe(201);
    });

    it('binds only through verified SSO with unprovisioned JIT off, and deactivation immediately fences sessions and JIT', async () => {
      const f = await setup(),
        email = `managed@${f.domain}`;
      const settingsReply = await api.send(
        'GET',
        `/v1/workspaces/${f.workspaceId}/sso`,
        { browser: f.owner },
      );
      const organization = settingsReply.json<{
        organization: { revision: number };
      }>().organization;
      await api.command(
        f.workspaceId,
        f.owner,
        `/providers/${f.providerId}`,
        {
          name: 'Fixture OIDC',
          configuration: { clientId: 'fixture-client', jitEnabled: false },
          enabled: true,
          expectedRevision: organization.revision,
        },
        'PUT',
      );
      const created = await createPerson(f, email);
      expect(created.statusCode, created.payload).toBe(201);
      const userId = created.json<{ id: string }>().id;
      expect(
        (
          await api
            .database()
            .query('select id from app.users where email=$1', [email])
        ).rowCount,
      ).toBe(0);
      const identity = api.person(email),
        signedIn = await api.finish(await api.start(f, identity));
      expect(signedIn.headers.location).not.toContain('ssoError');
      const browser = browserFrom(signedIn);
      const members = await api.send(
        'GET',
        `/v1/workspaces/${f.workspaceId}/members`,
        { browser: f.owner },
      );
      expect(members.statusCode, members.payload).toBe(200);
      const member = workspaceMembersResponseSchema
        .parse(members.json())
        .items.find((entry) => entry.email === email);
      expect(member?.directorySource?.directoryUserId).toBe(userId);
      if (member === undefined) throw new Error('Managed membership missing');
      const manualRoleChange = await api.send(
        'POST',
        `/v1/workspaces/${f.workspaceId}/members/${member.userId}/role`,
        {
          browser: f.owner,
          headers: { 'idempotency-key': randomUUID() },
          payload: { role: 'admin', expectedRoleRevision: member.roleRevision },
        },
      );
      expect(manualRoleChange.statusCode, manualRoleChange.payload).toBe(409);
      expect(manualRoleChange.payload).toContain('organization directory');
      const deactivated = await api.send('PATCH', `${f.base}/Users/${userId}`, {
        headers: f.headers,
        payload: patch([{ op: 'replace', path: 'active', value: false }]),
      });
      expect(deactivated.statusCode, deactivated.payload).toBe(200);
      expect(
        (await api.send('GET', '/v1/users/me', { browser })).statusCode,
      ).toBe(401);
      expect(
        (await api.finish(await api.start(f, identity))).headers.location,
      ).toContain('ssoError');
      const sessionCount = await api
        .database()
        .query<{ count: number }>(
          'select count(*)::integer count from app.auth_sessions session join app.users person on person.id=session.user_id where person.email=$1',
          [email],
        );
      expect(sessionCount.rows[0]?.count).toBe(0);
      expect(
        (
          await api.send('DELETE', `${f.base}/Users/${userId}`, {
            headers: f.headers,
          })
        ).statusCode,
      ).toBe(204);
      const replacement = await createPerson(f, email);
      expect(replacement.statusCode, replacement.payload).toBe(201);
      const restored = await api.finish(await api.start(f, identity));
      expect(restored.headers.location).not.toContain('ssoError');
      const refreshedMembers = await api.send(
        'GET',
        `/v1/workspaces/${f.workspaceId}/members`,
        { browser: f.owner },
      );
      expect(
        workspaceMembersResponseSchema
          .parse(refreshedMembers.json())
          .items.find((entry) => entry.email === email)?.directorySource
          ?.directoryUserId,
      ).toBe(replacement.json<{ id: string }>().id);
    });

    it('replays credential creation without a secret, never stores plaintext, and revokes machine access immediately', async () => {
      const f = await setup();
      const peer = await api.createIdentityPeer(encryption),
        digest = createHash('sha256').update(f.credential.secret).digest('hex');
      const organizationId = f.settings.organization?.id;
      if (organizationId === undefined) throw new Error('Missing organization');
      await expect(
        peer.directory.authenticate(organizationId, digest),
      ).resolves.toHaveProperty('credentialId', f.credential.credential.id);
      const before = await api.send(
        'GET',
        `/v1/workspaces/${f.workspaceId}/sso/directory`,
        { browser: f.owner },
      );
      const settings = directorySettingsSchema.parse(before.json()),
        key = randomUUID();
      const input = {
        browser: f.owner,
        headers: { 'idempotency-key': key },
        payload: {
          name: 'Retry credential',
          expectedRevision: settings.revision,
        },
      };
      const first = await api.send(
          'POST',
          `/v1/workspaces/${f.workspaceId}/sso/directory/credentials`,
          input,
        ),
        replay = await api.send(
          'POST',
          `/v1/workspaces/${f.workspaceId}/sso/directory/credentials`,
          input,
        );
      expect(first.statusCode, first.payload).toBe(200);
      expect(replay.statusCode, replay.payload).toBe(200);
      const issued = directoryCredentialResultSchema.parse(first.json());
      if (issued.replayed) throw new Error('Fresh credential replayed');
      expect(replay.json()).toMatchObject({
        replayed: true,
        credential: { id: issued.credential.id },
      });
      expect(replay.payload).not.toContain(issued.secret);
      const stored = await api
        .database()
        .query(
          'select secret_digest from app.auth_provisioning_credentials where id=$1',
          [issued.credential.id],
        );
      const receipts = await api
        .database()
        .query(
          'select result_ref from app.idempotency_records where workspace_id=$1',
          [f.workspaceId],
        );
      expect(JSON.stringify([stored.rows, receipts.rows])).not.toContain(
        issued.secret,
      );
      const revoked = await api.send(
        'POST',
        `/v1/workspaces/${f.workspaceId}/sso/directory/credentials/${f.credential.credential.id}/revoke`,
        {
          browser: f.owner,
          headers: { 'idempotency-key': randomUUID() },
          payload: { expectedRevision: settings.revision + 1 },
        },
      );
      expect(revoked.statusCode, revoked.payload).toBe(200);
      expect(
        (
          await api.send('GET', `${f.base}/ServiceProviderConfig`, {
            headers: f.headers,
          })
        ).statusCode,
      ).toBe(401);
      await expect(
        peer.directory.authenticate(organizationId, digest),
      ).rejects.toHaveProperty('reason', 'unauthorized');
    });
  },
);
