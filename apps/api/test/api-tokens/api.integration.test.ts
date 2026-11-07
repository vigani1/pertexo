import { describe, expect, it } from 'vitest';
import { betterAuthIntegrationEnabled } from '../support/better-auth/real-api.support.js';
import {
  createAutomationApiFixture,
  createDisabledAutomationFixture,
} from './api/api-token-api.fixture.js';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import {
  apiTokenCreateResponseSchema,
  apiTokenListResponseSchema,
  apiTokenRevokeResponseSchema,
} from '@pertexo/contracts';
import { createTokenWorkspace } from './api/portability/setup.js';
import { qualifyCredentialRuns } from './api/portability/runs.js';
import { qualifyReviewedPortability } from './api/portability/manifest.js';
import { qualifyRoleRevocation } from './api/portability/revocation.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'personal automation HTTP authentication',
  () => {
    const caseFixture = createAutomationApiFixture();

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
      expect(
        apiTokenListResponseSchema.parse(listed.json()).items,
      ).toHaveLength(1);
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
      const cookieOnly = await api.send('GET', `${path}/api-tokens`, {
        headers: bearer,
      });
      expect(cookieOnly.statusCode).toBe(403);
      expect(cookieOnly.json<{ code: string }>().code).toBe(
        'auth.token_not_supported',
      );
      expect(
        (await api.send('GET', `${path}/members`, { headers: bearer }))
          .statusCode,
      ).toBe(403);
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
      ).toBe(403);
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
      expect(
        apiTokenRevokeResponseSchema.parse(revoke.json()).token.status,
      ).toBe('revoked');
      expect(
        (await api.send('GET', `${path}/workflows`, { headers: bearer }))
          .statusCode,
      ).toBe(401);
    });

    it('uses publish, start, cancel and reviewed portability with credential-isolated receipts', async () => {
      const workspace = await createTokenWorkspace(caseFixture);
      const execution = await qualifyCredentialRuns(caseFixture, workspace);
      const portability = await qualifyReviewedPortability(
        caseFixture,
        workspace,
      );
      await qualifyRoleRevocation(caseFixture, {
        ...workspace,
        ...execution,
        ...portability,
      });
    });
  },
);
describe.runIf(betterAuthIntegrationEnabled)(
  'disabled automation availability',
  () => {
    const caseFixture = createDisabledAutomationFixture();

    const { api } = caseFixture;

    it('keeps metadata visible and explains disabled creation and authentication', async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/login?verified=true');
      const browser = await api.signIn(email);
      const created = await api.send('POST', '/v1/workspaces', {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Disabled automation',
          slug: `off-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(created.statusCode).toBe(201);
      const workspaceId = created.json<{ id: string }>().id;
      const base = `/v1/workspaces/${workspaceId}`;
      const listed = await api.send('GET', `${base}/api-tokens`, { browser });
      expect(listed.statusCode).toBe(200);
      expect(apiTokenListResponseSchema.parse(listed.json())).toMatchObject({
        enabled: false,
        items: [],
      });
      const issued = await api.send('POST', `${base}/api-tokens`, {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Not issued', scopes: ['run:read'] },
      });
      expect(issued.statusCode).toBe(503);
      expect(issued.json<{ code: string; detail: string }>()).toMatchObject({
        code: 'api_token.unavailable',
        detail: 'Automation tokens are disabled on this server.',
      });
      const synthetic = `ptx_1.${workspaceId}.${randomUUID()}.${'A'.repeat(43)}`;
      const authenticated = await api.send('GET', `${base}/workflows`, {
        headers: { authorization: `Bearer ${synthetic}` },
      });
      expect(authenticated.statusCode).toBe(503);
      expect(authenticated.json<{ code: string }>().code).toBe(
        'api_token.unavailable',
      );
      const count = await api
        .database()
        .query<{ count: number }>(
          'select count(*)::int count from app.api_tokens where workspace_id=$1',
          [workspaceId],
        );
      expect(count.rows[0]?.count).toBe(0);
    });
  },
);
