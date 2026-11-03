import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { betterAuthIntegrationEnabled } from '../../support/better-auth/real-api.support.js';
import { createAutomationApiFixture } from '../api/fixture.js';
import { createTokenWorkspace } from '../api/portability/setup.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'Step 5 public API boundaries',
  () => {
    const fixture = createAutomationApiFixture(),
      { api } = fixture;
    it('reports JSON Pointers for malformed params, queries and bodies on real declared routes', async () => {
      const w = await createTokenWorkspace(fixture);
      for (const [method, path, payload, pointer] of [
        [
          'POST',
          `${w.base}/data-tables/not-a-uuid/rows/query`,
          { filters: [], limit: 10, offset: 0 },
          '/tableId',
        ],
        ['GET', `${w.base}/workflows?limit=not-a-number`, undefined, '/limit'],
        ['GET', `${w.base}/workflows?limit=101`, undefined, '/limit'],
        ['POST', `${w.base}/workflows`, { name: '' }, '/name'],
      ] as const) {
        const reply = await api.send(method, path, {
          browser: w.browser,
          headers: { 'idempotency-key': randomUUID() },
          ...(payload === undefined ? {} : { payload }),
        });
        expect(reply.statusCode, reply.payload).toBe(400);
        expect(reply.json()).toMatchObject({
          code: 'request.invalid',
          errors: expect.arrayContaining([
            expect.objectContaining({ path: pointer }),
          ]) as unknown,
        });
      }
    });
    it('returns distinct 413 and 415 problems from a real route without echoing input', async () => {
      const w = await createTokenWorkspace(fixture);
      for (const [payload, contentType, status, code] of [
        [
          'private-oversize-' + 'x'.repeat(2_000_000),
          'application/json',
          413,
          'request.too_large',
        ],
        [
          'private-unsupported-body',
          'application/xml',
          415,
          'request.unsupported_media_type',
        ],
      ] as const) {
        const reply = await api.send('POST', `${w.base}/workflows`, {
          browser: w.browser,
          headers: {
            'content-type': contentType,
            'idempotency-key': randomUUID(),
          },
          payload,
        });
        expect(reply.statusCode, reply.payload).toBe(status);
        expect(reply.json()).toMatchObject({ code, status });
        expect(reply.payload).not.toContain('private-');
      }
    });
    it('executes and replays a whole token command with uppercase workspace spelling', async () => {
      const w = await createTokenWorkspace(fixture),
        key = randomUUID(),
        payload = { name: 'Uppercase token command' };
      const url = `/v1/workspaces/${w.workspaceId.toUpperCase()}/workflows`;
      const accepted = await api.send('POST', url, {
        headers: { ...w.headers, 'idempotency-key': key },
        payload,
      });
      expect(accepted.statusCode, accepted.payload).toBe(201);
      const replay = await api.send('POST', `${w.base}/workflows`, {
        headers: { ...w.headers, 'idempotency-key': key },
        payload,
      });
      expect(replay.statusCode, replay.payload).toBe(201);
      expect(replay.json()).toEqual(accepted.json());
      expect(
        (
          await api
            .database()
            .query(
              'select name from app.workflows where workspace_id=$1 and name=$2',
              [w.workspaceId, payload.name],
            )
        ).rows,
      ).toEqual([{ name: payload.name }]);
    });
    it('refuses unsupported token authentication before token validity, including cookie plus bearer', async () => {
      const w = await createTokenWorkspace(fixture);
      for (const caller of [
        { headers: { authorization: 'Bearer invalid-private-token' } },
        { browser: w.browser, headers: w.headers },
      ]) {
        const reply = await api.send('GET', `${w.base}/sso`, caller);
        expect(reply.statusCode, reply.payload).toBe(403);
        expect(reply.json()).toMatchObject({
          code: 'auth.token_not_supported',
        });
        expect(reply.payload).not.toContain('invalid-private-token');
      }
    });
    it('requires real CSRF for browser writes while token writes work without it', async () => {
      const w = await createTokenWorkspace(fixture);
      const reply = await api.send('POST', `${w.base}/workflows`, {
        headers: { cookie: w.browser.cookie, 'idempotency-key': randomUUID() },
        payload: { name: 'Missing CSRF' },
      });
      expect(reply.statusCode, reply.payload).toBe(403);
      expect(
        (
          await api
            .database()
            .query(
              'select id from app.workflows where workspace_id=$1 and name=$2',
              [w.workspaceId, 'Missing CSRF'],
            )
        ).rows,
      ).toEqual([]);
      const accepted = await api.send('POST', `${w.base}/workflows`, {
        headers: { ...w.headers, 'idempotency-key': randomUUID() },
        payload: { name: 'Token without CSRF' },
      });
      expect(accepted.statusCode, accepted.payload).toBe(201);
    });
    it('distinguishes a known path method mismatch from unknown and resource-missing paths', async () => {
      const w = await createTokenWorkspace(fixture);
      const mismatch = await api.send('DELETE', `${w.base}/workflows`, {
        browser: w.browser,
      });
      expect(mismatch.statusCode, mismatch.payload).toBe(405);
      expect(String(mismatch.headers.allow).split(/,\s*/u).toSorted()).toEqual([
        'GET',
        'HEAD',
        'POST',
      ]);
      const unknown = await api.send('DELETE', `${w.base}/not-a-route`, {
        browser: w.browser,
      });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.headers.allow).toBeUndefined();
      const missing = await api.send(
        'GET',
        `${w.base}/workflows/${randomUUID()}`,
        { headers: w.headers },
      );
      expect(missing.statusCode).toBe(404);
      expect(missing.headers.allow).toBeUndefined();
      const stale = await api.send(
        'GET',
        `${w.base}/workflows/${w.workflowId}/draft`,
        { headers: { ...w.headers, 'if-none-match': '"stale-tag"' } },
      );
      expect(stale.statusCode, stale.payload).toBe(200);
      expect(stale.json()).toHaveProperty('graph');
    });
    it('normalizes trailing auth and hook slashes and never reflects a webhook key in a 404', async () => {
      const w = await createTokenWorkspace(fixture);
      const security = await api.send('GET', '/v1/auth/account-security/', {
        browser: w.browser,
      });
      expect(security.statusCode, security.payload).toBe(200);
      for (const path of ['/hooks/', '/hooks/private-webhook-key/']) {
        const reply = await api.send('GET', path);
        expect(reply.statusCode, reply.payload).toBe(404);
        expect(reply.json()).not.toHaveProperty('instance');
        expect(reply.payload).not.toContain('private-webhook-key');
      }
    });
    it('keeps the readiness-owned 503 body during a real database connection outage', async () => {
      const {
        rows: [database],
      } = await api
        .database()
        .query<{ name: string }>('select current_database() name');
      if (database === undefined) throw new Error('Fixture database missing');
      await api
        .database()
        .query(
          `revoke connect on database "${database.name}" from public, pertexo_app`,
        );
      try {
        await api
          .database()
          .query(
            "select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and usename='pertexo_app'",
          );
        const reply = await api.send('GET', '/health/ready');
        expect(reply.statusCode, reply.payload).toBe(503);
        expect(reply.json()).toEqual({ status: 'not_ready' });
        expect(reply.headers['content-type']).toContain('application/json');
      } finally {
        await api
          .database()
          .query(
            `grant connect on database "${database.name}" to public, pertexo_app`,
          );
      }
      expect((await api.send('GET', '/health/ready')).statusCode).toBe(200);
    });

    it('requires draft validators conditionally, rejects stale ones, and duplicates a retained version without one', async () => {
      const w = await createTokenWorkspace(fixture),
        path = `${w.base}/workflows/${w.workflowId}`;
      const draft = { name: 'Qualified draft copy', source: { kind: 'draft' } };
      const missing = await api.send('POST', `${path}/duplicate`, {
        browser: w.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: draft,
      });
      expect(missing.statusCode, missing.payload).toBe(428);
      const other = await api.send('POST', `${w.base}/workflows`, {
        browser: w.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Another validator' },
      });
      expect(other.statusCode, other.payload).toBe(201);
      const stale = await api.send('POST', `${path}/duplicate`, {
        browser: w.browser,
        headers: {
          'idempotency-key': randomUUID(),
          'if-match': String(other.headers.etag),
        },
        payload: draft,
      });
      expect(stale.statusCode, stale.payload).toBe(412);
      const copied = await api.send('POST', `${path}/duplicate`, {
        browser: w.browser,
        headers: {
          'idempotency-key': randomUUID(),
          'if-match': String(w.saved.headers.etag),
        },
        payload: draft,
      });
      expect(copied.statusCode, copied.payload).toBe(201);
      const published = await api.send('POST', `${path}/publish`, {
        browser: w.browser,
        headers: {
          'idempotency-key': randomUUID(),
          'if-match': String(w.saved.headers.etag),
        },
        payload: {},
      });
      expect(published.statusCode, published.payload).toBe(200);
      const versionId = published.json<{ version: { id: string } }>().version
        .id;
      const version = await api.send('POST', `${path}/duplicate`, {
        browser: w.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Qualified retained copy',
          source: { kind: 'version', versionId },
        },
      });
      expect(version.statusCode, version.payload).toBe(201);
    });

    it('refuses malformed and duplicate credentials or command keys on a newly token-enabled write', async () => {
      const w = await createTokenWorkspace(fixture);
      const token = await api.send('POST', `${w.base}/api-tokens`, {
        browser: w.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Header qualification', scopes: ['workflow:update'] },
      });
      expect(token.statusCode, token.payload).toBe(201);
      const bearer = `Bearer ${token.json<{ secret: string }>().secret}`;
      const origin = await fixture.listen();
      const payload = JSON.stringify({
        name: 'Never stored',
        columns: [{ name: 'value', type: 'text' }],
      });
      for (const [headers, status] of [
        [
          [
            'Authorization',
            'Basic private-malformed-token',
            'Idempotency-Key',
            randomUUID(),
          ],
          401,
        ],
        [
          [
            'Authorization',
            bearer,
            'AUTHORIZATION',
            bearer,
            'Idempotency-Key',
            randomUUID(),
          ],
          401,
        ],
        [['Authorization', bearer, 'Idempotency-Key', 'contains a space'], 400],
        [
          [
            'Authorization',
            bearer,
            'Idempotency-Key',
            randomUUID(),
            'Idempotency-Key',
            randomUUID(),
          ],
          400,
        ],
      ] as const) {
        const reply = await new Promise<{
          status: number | undefined;
          body: string;
        }>((resolve, reject) => {
          const call = httpRequest(
            `${origin}${w.base}/data-tables`,
            {
              method: 'POST',
              agent: false,
              headers: [
                'Host',
                new URL(origin).host,
                ...headers,
                'Content-Type',
                'application/json',
                'Content-Length',
                String(Buffer.byteLength(payload)),
              ],
            },
            (response) => {
              let body = '';
              response.setEncoding('utf8');
              response.on('data', (chunk: string) => {
                body += chunk;
              });
              response.on('error', reject);
              response.on('end', () => {
                resolve({ status: response.statusCode, body });
              });
            },
          );
          call.on('error', reject);
          call.end(payload);
        });
        expect(reply.status, reply.body).toBe(status);
        expect(reply.body).not.toContain('private-malformed-token');
        expect(reply.body).not.toContain(bearer);
        expect(JSON.parse(reply.body)).toHaveProperty('requestId');
      }
      expect(
        (
          await api
            .database()
            .query(
              'select id from app.workspace_data_tables where workspace_id=$1',
              [w.workspaceId],
            )
        ).rows,
      ).toEqual([]);
    });
  },
);
