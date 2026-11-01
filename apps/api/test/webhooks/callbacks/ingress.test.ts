import { createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { StructuredLogger } from '@pertexo/observability';
import { afterEach, expect, it, vi } from 'vitest';
import {
  callbackWaitConfigSchema,
  type CallbackWaitConfig,
} from '@pertexo/workflow-model';
import {
  callbackTokenHash,
  createCallbackTokenKeys,
} from '@pertexo/integrations/server';
import { CallbackResponseError, type CallbackStore } from '@pertexo/core/runs';
import { registerCallbackIngress } from '../../../src/webhooks/callbacks/ingress.js';
import { silentLogger } from '../../support/silent-logger.js';
const close: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of close.splice(0).reverse()) await cleanup();
});
function fixture(authentication: CallbackWaitConfig['authentication']) {
  const keys = createCallbackTokenKeys({
    origin: 'https://example.test',
    keys: {
      current: { version: '1', key: Buffer.alloc(32, 70).toString('base64') },
      previous: [],
    },
  });
  const id = '01a10000-0000-7000-8000-000000000001';
  const material = keys.material({ id }, '1');
  const config = callbackWaitConfigSchema.parse({
    mode: 'callback',
    timeoutSeconds: 3600,
    authentication,
  });
  const callback = {
    id,
    workspaceId: '01a10000-0000-7000-8000-000000000002',
    runId: '01a10000-0000-7000-8000-000000000003',
    nodeId: 'wait',
    scopeHash: 'a'.repeat(64),
    tokenHash: callbackTokenHash(material.token),
    keyVersion: '1',
    config,
    databaseTime: new Date(),
  };
  let answered = false;
  let refused: 'closed' | undefined;
  let unavailable = false;
  const retained: string[] = [];
  const store: CallbackStore = {
    prepare: () => Promise.resolve([]),
    resolve: (hash) =>
      Promise.resolve(hash === callback.tokenHash ? callback : null),
    respond: async (input) => {
      await Promise.resolve();
      if (refused !== undefined) throw new CallbackResponseError(refused);
      if (answered) throw new CallbackResponseError('resolved');
      retained.push(
        input.redactOutput(
          JSON.stringify({ kind: 'inline', value: input.output }),
        ),
      );
      answered = true;
    },
    keysInUse: async function* () {
      yield* await Promise.resolve([]);
    },
    close: () => Promise.resolve(),
  };
  const app: FastifyInstance = Fastify();
  registerCallbackIngress(app, {
    store,
    keys,
    rateLimitConsumer: {
      consume: async () => {
        await Promise.resolve();
        if (unavailable) throw new Error('Rate backend down');
        return { allowed: true };
      },
    },
    logger: silentLogger,
  });
  close.push(async () => {
    await app.close();
    keys.close();
  });
  return {
    app,
    material,
    callback,
    retained,
    expire: () => {
      refused = 'closed';
    },
    unavailable: () => {
      unavailable = true;
    },
    url: `/hooks/${material.token}/resume`,
  };
}
it.each(['secret_url', 'signed', 'header_secret'] as const)(
  'accepts one authenticated %s callback and returns safe duplicate and expired problems',
  async (mode) => {
    const f = fixture(
      mode === 'header_secret'
        ? { mode, headerName: 'authorization', allowedOrigins: [] }
        : { mode, allowedOrigins: [] },
    );
    const payload = '{"amount":17}';
    const timestamp = String(
      Math.floor(f.callback.databaseTime.getTime() / 1000),
    );
    let auth;
    if (mode === 'signed') {
      auth = {
        'x-pertexo-timestamp': timestamp,
        'x-pertexo-signature': `v1=${createHmac(
          'sha256',
          Buffer.from(f.material.secret, 'base64url'),
        )
          .update(timestamp + '.' + payload)
          .digest('hex')}`,
      };
    } else if (mode === 'header_secret') {
      auth = { authorization: `Bearer ${f.material.secret}` };
    } else {
      auth = {};
    }
    const input = {
      method: 'POST' as const,
      url: f.url,
      headers: { 'content-type': 'application/json', ...auth },
      payload,
    };
    expect((await f.app.inject(input)).statusCode).toBe(202);
    expect((await f.app.inject(input)).statusCode).toBe(409);
    f.expire();
    expect((await f.app.inject(input)).statusCode).toBe(410);
    expect(f.retained).toHaveLength(1);
    expect(JSON.parse(f.retained[0] ?? '{}')).toMatchObject({
      kind: 'inline',
      value: { body: { amount: 17 } },
    });
  },
);
it('uses the existing non-disclosing authentication failure for bad secrets and unknown URLs', async () => {
  const f = fixture({
    mode: 'header_secret',
    headerName: 'x-callback-secret',
    allowedOrigins: [],
  });
  for (const url of [f.url, `/hooks/${'z'.repeat(43)}/resume`]) {
    const response = await f.app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        'x-callback-secret': 'bad',
      },
      payload: '{}',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      code: 'webhook.authentication_failed',
    });
  }
  expect(f.retained).toEqual([]);
});
it('redacts JSON-escaped URL and secret echoes and excludes authorization and proxy headers', async () => {
  const f = fixture({
    mode: 'header_secret',
    headerName: 'x-callback-secret',
    allowedOrigins: [],
  });
  const payload = JSON.stringify({
    url: f.material.url,
    secret: f.material.secret,
  }).replaceAll(
    f.material.token,
    Array.from(
      f.material.token,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    ).join(''),
  );
  const response = await f.app.inject({
    method: 'POST',
    url: f.url,
    headers: {
      'content-type': 'application/json',
      'x-callback-secret': f.material.secret,
      authorization: 'private',
      cookie: 'private',
      'x-forwarded-for': 'private',
      'x-echo': f.material.secret,
    },
    payload,
  });
  expect(response.statusCode).toBe(202);
  const retained = f.retained.join('');
  expect(retained).not.toContain(f.material.token);
  expect(retained).not.toContain(f.material.secret);
  expect(retained).not.toContain('private');
  expect(retained).toContain('[Redacted]');
});
it('does not consume a callback during preflight or a GET/HEAD probe and fails closed when rate limiting is unavailable', async () => {
  const f = fixture({
    mode: 'secret_url',
    allowedOrigins: ['https://caller.test'],
  });
  const preflight = await f.app.inject({
    method: 'OPTIONS',
    url: f.url,
    headers: {
      origin: 'https://caller.test',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  expect(preflight.statusCode).toBe(204);
  expect(preflight.headers['access-control-allow-origin']).toBe(
    'https://caller.test',
  );
  expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
  for (const method of ['GET', 'HEAD'] as const)
    expect((await f.app.inject({ method, url: f.url })).statusCode).toBe(405);
  expect(f.retained).toEqual([]);
  f.unavailable();
  expect((await f.app.inject({ method: 'POST', url: f.url })).statusCode).toBe(
    503,
  );
  expect(f.retained).toEqual([]);
});
it('refuses oversized or malformed input without accepting the callback', async () => {
  const f = fixture({ mode: 'secret_url', allowedOrigins: [] });
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: f.url,
        headers: { 'content-type': 'application/json' },
        payload: 'x'.repeat(262145),
      })
    ).statusCode,
  ).toBe(413);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: f.url,
        headers: { 'content-type': 'application/json' },
        payload: '{bad',
      })
    ).statusCode,
  ).toBe(400);
  expect(f.retained).toEqual([]);
});
// api-03: an outage behind callback ingress must reach the logs with its cause.
it('logs the cause when a callback cannot be read', async () => {
  const keys = createCallbackTokenKeys({
    origin: 'https://example.test',
    keys: {
      current: { version: '1', key: Buffer.alloc(32, 71).toString('base64') },
      previous: [],
    },
  });
  const failure = new Error('callback read failed');
  const store: CallbackStore = {
    prepare: () => Promise.resolve([]),
    resolve: () => Promise.reject(failure),
    respond: () => Promise.resolve(),
    keysInUse: async function* () {
      yield* await Promise.resolve([]);
    },
    close: () => Promise.resolve(),
  };
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  } satisfies StructuredLogger;
  const dependencies = {
    store,
    keys,
    rateLimitConsumer: {
      consume: () => Promise.resolve({ allowed: true as const }),
    },
    logger,
  };
  const app = Fastify();
  registerCallbackIngress(app, dependencies);
  close.push(async () => {
    await app.close();
    keys.close();
  });
  const token = keys.material(
    { id: '01a10000-0000-7000-8000-000000000009' },
    '1',
  ).token;
  const response = await app.inject({
    method: 'POST',
    url: `/hooks/${token}/resume`,
    headers: { 'content-type': 'application/json' },
    payload: '{}',
  });
  expect(response.statusCode).toBe(503);
  expect(response.json()).toMatchObject({ code: 'callback.unavailable' });
  expect(logger.error).toHaveBeenCalledOnce();
  expect(logger.error.mock.calls[0]).toContain(failure);
});
