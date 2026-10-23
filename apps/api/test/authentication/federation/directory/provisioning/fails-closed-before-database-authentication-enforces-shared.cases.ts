import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import { registerDirectoryTransport } from '../../../../../src/authentication/federation/provisioning/transport/register.js';
import type { createDirectoryFixture } from './fixture.js';
import { coreGroup, patch } from './fixture.js';

export function registerFailsClosedBeforeDatabaseAuthenticationEnforcesShared(
  caseFixture: ReturnType<typeof createDirectoryFixture>,
): void {
  const { setup, api, createPerson } = caseFixture;

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
            ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }),
          });
          expect(reply.statusCode).toBe(mode === 'backend' ? 503 : 429);
          expect(reply.headers['content-type']).toContain(
            'application/scim+json',
          );
          expect(authenticated).toHaveBeenCalledTimes(mode === 'post' ? 1 : 0);
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
    const discovery = await api.send('GET', `${f.base}/ServiceProviderConfig`, {
      headers: f.headers,
    });
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
    const lateFailure = await api.send('PATCH', `${f.base}/Users/${user.id}`, {
      headers: f.headers,
      payload: patch([
        { op: 'replace', path: 'displayName', value: 'Should roll back' },
        {
          op: 'replace',
          path: 'emails[value eq "missing"].value',
          value: 'other@example.test',
        },
      ]),
    });
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
}
