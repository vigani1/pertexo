import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ConnectionEnvelopeEncryption,
  type ConnectionSecretContext,
} from '@pertexo/secrets/server';
import { createEditorBrowserEnvelopeKeys } from '../../../../infrastructure/testing/editor-browser-envelope-keys.mjs';
import type { ConnectionHttpClient } from '../../src/connections/index.js';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
  type Browser,
} from '../support/better-auth/real-api.support.js';

type Reply = Readonly<{ status: number; body?: object }>;

/**
 * Testing a saved connection over real HTTP, Postgres and the real Slack and
 * Resend clients. Only the providers' HTTP endpoints are replaced.
 */
describe.runIf(betterAuthIntegrationEnabled)(
  'connection provider tests',
  () => {
    const keys = createEditorBrowserEnvelopeKeys<ConnectionSecretContext>(
      randomBytes(32),
      'connection',
    );
    const calls: {
      url: string;
      headers: Record<string, string>;
      body?: string;
    }[] = [];
    let reply: Reply = { status: 200 };
    const provider: ConnectionHttpClient = {
      execute: async (request) => {
        await request.beforeDispatch();
        calls.push({
          url: request.url,
          headers: { ...request.headers },
          ...(request.body instanceof Uint8Array
            ? { body: new TextDecoder().decode(request.body) }
            : {}),
        });
        return {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify(reply.body ?? {})),
          bodyEncoding: 'utf8' as const,
          finalUrl: request.url,
          redirectCount: 0,
        };
      },
    };
    const api = useBetterAuthRealApi('connection_provider_test', {
      connections: {
        config: { kmsKeyReference: 'provider-test', region: 'us-east-1' },
        services: () => ({
          encryption: { encryption: new ConnectionEnvelopeEncryption(keys) },
          http: provider,
        }),
      },
    });
    afterAll(() => {
      keys.close();
    });

    it('stores each HTTP answer as the connection outcome, limits tests per connection and replays a repeated test without calling again', async () => {
      const w = await workspace();
      const id = await w.create('http', {
        type: 'http_headers',
        headers: { authorization: 'Bearer provider-test-secret' },
      });
      const health = { url: 'https://provider.example.test/health' };

      for (const [status, expected] of [
        [200, { ok: true, httpStatus: 200, errorCode: null }],
        [
          400,
          {
            ok: false,
            httpStatus: 400,
            errorCode: 'connection.provider_rejected',
          },
        ],
        [
          429,
          {
            ok: false,
            httpStatus: 429,
            errorCode: 'connection.provider_rate_limited',
          },
        ],
        [
          500,
          {
            ok: false,
            httpStatus: 500,
            errorCode: 'connection.provider_unavailable',
          },
        ],
      ] as const) {
        reply = { status };
        const tested = await w.test(id, health);
        expect(tested.statusCode, tested.payload).toBe(200);
        expect(tested.json()).toMatchObject({ outcome: expected });
      }
      expect(calls.at(-1)).toEqual({
        url: health.url,
        headers: { authorization: 'Bearer provider-test-secret' },
      });

      // Five tests a minute per connection: the sixth is refused before it
      // reaches the provider.
      reply = { status: 200 };
      expect((await w.test(id, health)).statusCode).toBe(200);
      const tested = calls.length;
      const limited = await w.test(id, health);
      expect(limited.statusCode, limited.payload).toBe(429);
      expect(limited.json()).toMatchObject({ code: 'request.rate_limited' });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(calls).toHaveLength(tested);
      expect(await w.claims(id)).toEqual({ completed: 5, open: 0 });

      const rejecting = await w.create('http', {
        type: 'http_headers',
        headers: { authorization: 'Bearer provider-test-secret' },
      });
      reply = { status: 401 };
      const key = randomUUID();
      const rejected = await w.test(rejecting, health, key);
      expect(rejected.statusCode, rejected.payload).toBe(200);
      expect(rejected.json()).toMatchObject({
        outcome: {
          ok: false,
          httpStatus: 401,
          errorCode: 'connection.credential_rejected',
        },
        connection: { status: 'reauthorization_required' },
      });
      expect(rejected.payload).not.toContain('provider-test-secret');
      const made = calls.length;
      reply = { status: 200 };
      const replay = await w.test(rejecting, health, key);
      expect(replay.statusCode, replay.payload).toBe(200);
      expect(replay.json()).toEqual(rejected.json());
      expect(calls).toHaveLength(made);
      expect(await w.claims(rejecting)).toEqual({ completed: 1, open: 0 });
    });

    it('reads Slack and Resend answers through their real clients', async () => {
      const w = await workspace();
      const slack = await w.create('slack', {
        type: 'slack_bot_token',
        botToken: 'xoxb-123456789-provider-test',
      });
      reply = { status: 200, body: { ok: false, error: 'token_revoked' } };
      const revoked = await w.test(slack, { providerKey: 'slack' });
      expect(revoked.statusCode, revoked.payload).toBe(200);
      expect(revoked.json()).toMatchObject({
        outcome: {
          ok: false,
          httpStatus: 200,
          errorCode: 'connection.slack_token_revoked',
        },
        connection: { status: 'reauthorization_required' },
      });
      expect(calls.at(-1)).toMatchObject({
        url: 'https://slack.com/api/auth.test',
        headers: { authorization: 'Bearer xoxb-123456789-provider-test' },
      });

      const email = await w.create('email', {
        type: 'resend_api_key',
        apiKey: 're_123456789_provider_test',
        fromEmail: 'sender@example.test',
      });
      reply = { status: 429 };
      const limited = await w.test(email, {
        providerKey: 'email',
        sideEffectDisclosureAccepted: true,
      });
      expect(limited.statusCode, limited.payload).toBe(200);
      expect(limited.json()).toMatchObject({
        outcome: {
          ok: false,
          httpStatus: 429,
          errorCode: 'connection.provider_rate_limited',
        },
      });
      const sent = calls.at(-1);
      expect(sent?.url).toBe('https://api.resend.com/emails');
      expect(JSON.parse(sent?.body ?? '{}')).toMatchObject({
        to: ['delivered@resend.dev'],
        subject: 'Pertexo Resend connection test',
        text: 'This message verifies a Pertexo Resend sending connection.',
      });
      const providerKey = sent?.headers['idempotency-key'];
      expect(providerKey).toMatch(/^pertexo-connection-test-v1-[0-9a-f]{64}$/);
      await w.test(email, {
        providerKey: 'email',
        sideEffectDisclosureAccepted: true,
      });
      expect(calls.at(-1)?.headers['idempotency-key']).not.toBe(providerKey);
    });

    it('refuses to test a connection as another provider before opening its credential', async () => {
      const w = await workspace();
      const id = await w.create('http', {
        type: 'http_headers',
        headers: { authorization: 'Bearer provider-test-secret' },
      });
      const made = calls.length;
      for (const request of [
        { providerKey: 'slack' },
        { providerKey: 'email', sideEffectDisclosureAccepted: true },
      ]) {
        const refused = await w.test(id, request);
        expect(refused.statusCode, refused.payload).toBeGreaterThanOrEqual(400);
        expect(refused.statusCode, refused.payload).toBeLessThan(500);
        expect(refused.payload).not.toContain('provider-test-secret');
      }
      expect(calls).toHaveLength(made);
      expect(await w.claims(id)).toEqual({ completed: 0, open: 0 });
    });

    async function workspace() {
      const email = `provider-test-${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      const browser: Browser = await api.signIn(email);
      const created = await api.send('POST', '/v1/workspaces', {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Provider tests',
          slug: `provider-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const workspaceId = created.json<{ id: string }>().id;
      const base = `/v1/workspaces/${workspaceId}/connections`;
      return {
        async create(providerKey: string, credential: object) {
          const made = await api.send('POST', base, {
            browser,
            headers: { 'idempotency-key': randomUUID() },
            payload: {
              providerKey,
              name: `${providerKey} probe ${randomUUID().slice(0, 8)}`,
              credential,
            },
          });
          expect(made.statusCode, made.payload).toBe(201);
          return made.json<{ id: string }>().id;
        },
        test(id: string, payload: object, key: string = randomUUID()) {
          return api.send('POST', `${base}/${id}/test`, {
            browser,
            headers: { 'idempotency-key': key },
            payload,
          });
        },
        /** Every finished test leaves a completed claim and none stays in progress. */
        async claims(id: string) {
          const rows = await api.database().query<{
            completed: number;
            open: number;
          }>(
            `select count(*) filter (where status='completed')::int completed,
                  count(*) filter (where status='in_progress')::int open
             from app.idempotency_records
            where workspace_id=$1 and operation='connection.test' and scope like $2`,
            [workspaceId, `%:${id}`],
          );
          return rows.rows[0];
        },
      };
    }
  },
);

describe.runIf(betterAuthIntegrationEnabled)(
  'connection tests through the real secure HTTP client',
  () => {
    const keys = createEditorBrowserEnvelopeKeys<ConnectionSecretContext>(
      randomBytes(32),
      'connection',
    );
    const api = useBetterAuthRealApi('connection_provider_ssrf', {
      connections: {
        config: { kmsKeyReference: 'provider-ssrf', region: 'us-east-1' },
        services: () => ({
          encryption: { encryption: new ConnectionEnvelopeEncryption(keys) },
        }),
      },
    });
    afterAll(() => {
      keys.close();
    });

    it('records a blocked address as a safe outcome without the credential', async () => {
      const email = `provider-ssrf-${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      const browser = await api.signIn(email);
      const created = await api.send('POST', '/v1/workspaces', {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Blocked provider',
          slug: `ssrf-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const base = `/v1/workspaces/${created.json<{ id: string }>().id}/connections`;
      const connection = await api.send('POST', base, {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          providerKey: 'http',
          name: 'Metadata probe',
          credential: {
            type: 'http_headers',
            headers: { authorization: 'Bearer blocked-provider-secret' },
          },
        },
      });
      expect(connection.statusCode, connection.payload).toBe(201);
      const tested = await api.send(
        'POST',
        `${base}/${connection.json<{ id: string }>().id}/test`,
        {
          browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { url: 'https://169.254.169.254/latest/meta-data' },
        },
      );
      expect(tested.statusCode, tested.payload).toBe(200);
      expect(tested.json()).toMatchObject({
        outcome: {
          ok: false,
          httpStatus: null,
          errorCode: 'connection.test.ssrf_blocked',
        },
      });
      expect(tested.payload).not.toContain('blocked-provider-secret');
    });
  },
);
