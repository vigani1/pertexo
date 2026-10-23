import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';

import { expect, it } from 'vitest';
import {
  apiTokenCreateResponseSchema,
  apiTokenListResponseSchema,
  apiTokenRevokeResponseSchema,
} from '@pertexo/contracts';

import type { createAutomationApiFixture } from './fixture.js';

export function registerCreatesOnceThroughRealBrowserSessionAuthenticates(
  caseFixture: ReturnType<typeof createAutomationApiFixture>,
): void {
  const { api, listen } = caseFixture;

  it('creates once through a real browser session, authenticates only scoped routes and revokes', async () => {
    const email = `${randomUUID()}@example.test`;
    await api.signUp(email, '/login?verified=true');
    const browser = await api.signIn(email);
    const workspace = await api.send('POST', '/v1/workspaces', {
      browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        name: 'Automation team',
        slug: `tokens-${randomUUID().slice(0, 8)}`,
      },
    });
    expect(workspace.statusCode).toBe(201);
    const workspaceId = workspace.json<{ id: string }>().id;
    const path = `/v1/workspaces/${workspaceId}`;
    const command = {
      browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        name: 'Read-only script',
        scopes: ['workflow:read', 'run:read'],
      },
    };
    const reply = await api.send('POST', `${path}/api-tokens`, command);
    expect(reply.statusCode).toBe(201);
    expect(reply.headers['cache-control']).toBe('private, no-store');
    const created = apiTokenCreateResponseSchema.parse(reply.json());
    if (created.replayed) throw new Error('First token creation replayed');
    const bearer = { authorization: `Bearer ${created.secret}` };
    const replay = await api.send('POST', `${path}/api-tokens`, command);
    expect(replay.statusCode).toBe(201);
    expect(
      apiTokenCreateResponseSchema.parse(replay.json()),
    ).not.toHaveProperty('secret');
    const listed = await api.send('GET', `${path}/api-tokens`, { browser });
    expect(listed.statusCode).toBe(200);
    expect(apiTokenListResponseSchema.parse(listed.json()).items).toHaveLength(
      1,
    );
    expect(listed.payload).not.toContain(created.secret);
    for (const resource of ['workflows', 'runs']) {
      expect(
        (await api.send('GET', `${path}/${resource}`, { headers: bearer }))
          .statusCode,
      ).toBe(200);
    }
    const origin = await listen();
    const repeatedHeaderStatus = await new Promise<number>(
      (resolve, reject) => {
        const call = httpRequest(
          `${origin}${path}/workflows`,
          {
            agent: false,
            headers: [
              'Host',
              new URL(origin).host,
              'Authorization',
              `Bearer ${created.secret}`,
              'AUTHORIZATION',
              `Bearer ${created.secret}`,
            ],
          },
          (response) => {
            response.resume();
            response.once('end', () => {
              resolve(response.statusCode ?? 0);
            });
          },
        );
        call.once('error', reject);
        call.end();
      },
    );
    expect(repeatedHeaderStatus).toBe(401);
    expect(
      (await api.send('GET', `${path}/api-tokens`, { headers: bearer }))
        .statusCode,
    ).toBe(401);
    expect(
      (await api.send('GET', `${path}/members`, { headers: bearer }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await api.send('GET', `${path}/workflows`, {
          browser,
          headers: bearer,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await api.send('POST', `${path}/workflows/${randomUUID()}/runs`, {
          headers: { ...bearer, 'idempotency-key': randomUUID() },
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    const malformed = await api.send('GET', `${path}/workflows`, {
      browser,
      headers: { authorization: 'Bearer invalid' },
    });
    expect(malformed.statusCode).toBe(401);
    expect(malformed.headers['www-authenticate']).toContain('Bearer');
    const revoke = await api.send(
      'POST',
      `${path}/api-tokens/${created.token.id}/revoke`,
      { browser, headers: { 'idempotency-key': randomUUID() }, payload: {} },
    );
    expect(revoke.statusCode).toBe(200);
    expect(apiTokenRevokeResponseSchema.parse(revoke.json()).token.status).toBe(
      'revoked',
    );
    expect(
      (await api.send('GET', `${path}/workflows`, { headers: bearer }))
        .statusCode,
    ).toBe(401);
  });
}
