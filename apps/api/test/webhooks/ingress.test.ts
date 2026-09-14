import { createHmac } from 'node:crypto';
import { request as sendHttpRequest } from 'node:http';

import type {
  WebhookTriggerDatabase,
  WebhookVerificationReference,
} from '@pertexo/database/testing';
import {
  RegionalWriteAdmissionPausedError,
  WebhookDeliveryIneligibleError,
  WebhookDeliveryReplayMismatchError,
  WebhookIngressRateLimitExceededError,
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
} from '@pertexo/database/testing';
import type { WebhookTriggerEnvelopeEncryption } from '@pertexo/integrations/server';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerWebhookIngress } from '../../src/webhooks/ingress.js';
import type { WebhookIngressTelemetry } from '../../src/webhooks/telemetry.js';

const endpointKey = 'a'.repeat(43);
const currentSecret = new Uint8Array(32).fill(4);
const previousSecret = new Uint8Array(32).fill(5);
const now = new Date('2026-08-25T12:00:00.000Z');
const timestamp = String(now.getTime() / 1000);
const verification: WebhookVerificationReference = {
  endpointId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  endpointKeyHash: 'a'.repeat(64),
  workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  triggerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  workflowId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  workflowVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  nodeId: 'webhook',
  databaseTime: now,
  currentSecret: sealed('11111111-1111-4111-8111-111111111111'),
  previousSecret: {
    ...sealed('22222222-2222-4222-8222-222222222222'),
    validUntil: new Date(now.getTime() + 1),
  },
};

describe('generic webhook ingress', () => {
  const applications: FastifyInstance[] = [];
  beforeEach(() => {
    currentSecret.fill(4);
    previousSecret.fill(5);
  });
  afterEach(async () => {
    await Promise.all(
      applications.splice(0).map((application) => application.close()),
    );
  });

  it('verifies exact raw bytes before parsing and returns strict 202', async () => {
    const { application, database, delivery, deduplication, health, trace } =
      setup();
    const body = '{"value": 1}\n';
    const response = await application.inject(request(body, currentSecret));

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: false,
    });
    expect(database.acceptVerifiedDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { value: 1 },
        traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      }),
    );
    expect(database.consumeIngressLimit).toHaveBeenCalledOnce();
    expect(delivery).toHaveBeenCalledWith('accepted');
    expect(deduplication).toHaveBeenCalledWith('new');
    expect(health).toHaveBeenCalledWith('healthy');
    expect(trace).toHaveBeenCalledOnce();

    const changed = await application.inject({
      ...request('{"value":1}\n', currentSecret),
      headers: request(body, currentSecret).headers,
    });
    expect(changed.statusCode).toBe(401);
  });

  it('accepts delivery without optional idempotency or trace context', async () => {
    const fixture = setup(undefined, undefined, undefined, false);
    fixture.database.acceptVerifiedDelivery.mockResolvedValueOnce({
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: false,
    });
    const base = request('{}', currentSecret);
    const headers = { ...base.headers } as Record<string, string>;
    delete headers['idempotency-key'];
    const response = await fixture.application.inject({ ...base, headers });

    expect(response.statusCode).toBe(202);
    const call = vi.mocked(fixture.database.acceptVerifiedDelivery).mock
      .calls[0];
    expect(Object.hasOwn(call?.[0] as object, 'idempotencyKeyHash')).toBe(
      false,
    );
  });

  it.each([
    {
      name: 'a synchronous trace failure before the callback',
      trace: <T>(_parent: string | undefined, _work: () => Promise<T>) => {
        void _parent;
        void _work;
        throw new Error('trace failed before callback');
      },
    },
    {
      name: 'a trace rejection before the callback',
      trace: <T>(
        _parent: string | undefined,
        _work: () => Promise<T>,
      ): Promise<T> => {
        void _parent;
        void _work;
        return Promise.reject(new Error('trace rejected before callback'));
      },
    },
    {
      name: 'a synchronous trace failure after the callback',
      trace: <T>(_parent: string | undefined, work: () => Promise<T>) => {
        void work();
        throw new Error('trace failed after callback');
      },
    },
    {
      name: 'a trace rejection after the callback',
      trace: <T>(
        _parent: string | undefined,
        work: () => Promise<T>,
      ): Promise<T> => {
        void work();
        return Promise.reject(new Error('trace rejected after callback'));
      },
    },
  ] satisfies readonly Readonly<{
    name: string;
    trace: WebhookIngressTelemetry['trace'];
  }>[])('accepts exactly once through $name', async ({ trace }) => {
    const fixture = setup(undefined, undefined, undefined, true, { trace });

    const response = await fixture.application.inject(
      request('{}', currentSecret),
    );

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: false,
    });
    expect(fixture.database.acceptVerifiedDelivery).toHaveBeenCalledOnce();
    expect(fixture.openedSecrets).toHaveLength(2);
    for (const secret of fixture.openedSecrets)
      expect(secret).toEqual(new Uint8Array(32));
  });

  it('returns one authoritative acceptance when tracing invokes its callback twice', async () => {
    let firstPromise: Promise<unknown> | undefined;
    const fixture = setup(undefined, undefined, undefined, true, {
      trace: <T>(_parent: string | undefined, work: () => Promise<T>) => {
        const first = work();
        const second = work();
        firstPromise = first;
        expect(second).toBe(first);
        return first;
      },
    });

    const response = await fixture.application.inject(
      request('{}', currentSecret),
    );

    expect(response.statusCode).toBe(202);
    expect(firstPromise).toBeDefined();
    expect(fixture.database.acceptVerifiedDelivery).toHaveBeenCalledOnce();
    expect(fixture.delivery).toHaveBeenCalledTimes(1);
  });

  it('treats unavailable diagnostic trace context as absent', async () => {
    const fixture = setup(undefined, undefined, undefined, true, {
      traceparent: () => {
        throw new Error('active trace context is unavailable');
      },
    });

    const response = await fixture.application.inject(
      request('{}', currentSecret),
    );

    expect(response.statusCode).toBe(202);
    const input: unknown =
      fixture.database.acceptVerifiedDelivery.mock.calls[0]?.[0];
    expect(Object.hasOwn(input as object, 'traceparent')).toBe(false);
    expect(fixture.database.acceptVerifiedDelivery).toHaveBeenCalledOnce();
  });

  it('preserves a failed acceptance while the trace promise also rejects', async () => {
    const workFailure = new Error('database unavailable');
    const fixture = setup(undefined, workFailure, undefined, true, {
      trace: <T>(_parent: string | undefined, work: () => Promise<T>) => {
        void work();
        return Promise.reject(new Error('trace export unavailable'));
      },
    });

    const response = await fixture.application.inject(
      request('{}', currentSecret),
    );

    expect(response.statusCode).toBe(503);
    expect(response.json<{ code: string }>().code).toBe('webhook.unavailable');
    expect(fixture.database.acceptVerifiedDelivery).toHaveBeenCalledOnce();
    for (const secret of fixture.openedSecrets)
      expect(secret).toEqual(new Uint8Array(32));
  });

  it('consumes the durable endpoint limit before opening a signing secret', async () => {
    const { application, database, openSecret } = setup();
    database.consumeIngressLimit.mockRejectedValueOnce(
      new WebhookIngressRateLimitExceededError(17),
    );
    const response = await application.inject(request('{}', currentSecret));
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('17');
    expect(response.json<{ code: string }>().code).toBe('webhook.rate_limited');
    expect(openSecret).not.toHaveBeenCalled();
    expect(database.acceptVerifiedDelivery).not.toHaveBeenCalled();
  });

  it('authenticates valid signatures before reporting malformed JSON', async () => {
    const { application, database } = setup();
    const valid = await application.inject(request('{', currentSecret));
    const invalid = await application.inject({
      ...request('{', currentSecret),
      headers: {
        ...request('{', currentSecret).headers,
        'x-pertexo-signature': `v1=${'0'.repeat(64)}`,
      },
    });
    expect(valid.statusCode).toBe(400);
    expect(valid.json<{ code: string }>().code).toBe('webhook.invalid_json');
    expect(invalid.statusCode).toBe(401);
    expect(database.acceptVerifiedDelivery).not.toHaveBeenCalled();
  });

  it('rejects validly signed malformed UTF-8 after authentication', async () => {
    const { application, database } = setup();
    const body = new Uint8Array([0xc3, 0x28]);

    const response = await application.inject({
      method: 'POST',
      url: `/hooks/${endpointKey}`,
      headers: {
        'content-type': 'application/json',
        'x-pertexo-timestamp': timestamp,
        'x-pertexo-signature': signature(body, currentSecret),
      },
      payload: Buffer.from(body),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('webhook.invalid_json');
    expect(database.acceptVerifiedDelivery).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'missing timestamp',
      headers: () => removeRawHeader(rawHeaders('{}'), 'x-pertexo-timestamp'),
      status: 401,
      code: 'webhook.authentication_failed',
    },
    {
      name: 'duplicate timestamp',
      headers: () => [...rawHeaders('{}'), 'x-pertexo-timestamp', timestamp],
      status: 401,
      code: 'webhook.authentication_failed',
    },
    {
      name: 'comma-folded timestamp',
      headers: () =>
        replaceRawHeader(
          rawHeaders('{}'),
          'x-pertexo-timestamp',
          `${timestamp},${timestamp}`,
        ),
      status: 401,
      code: 'webhook.authentication_failed',
    },
    {
      name: 'missing signature',
      headers: () => removeRawHeader(rawHeaders('{}'), 'x-pertexo-signature'),
      status: 401,
      code: 'webhook.authentication_failed',
    },
    {
      name: 'duplicate signature',
      headers: () => [
        ...rawHeaders('{}'),
        'x-pertexo-signature',
        signature('{}', currentSecret),
      ],
      status: 401,
      code: 'webhook.authentication_failed',
    },
    {
      name: 'comma-folded signature',
      headers: () =>
        replaceRawHeader(
          rawHeaders('{}'),
          'x-pertexo-signature',
          `${signature('{}', currentSecret)},${signature('{}', currentSecret)}`,
        ),
      status: 401,
      code: 'webhook.authentication_failed',
    },
    {
      name: 'missing content type',
      headers: () => removeRawHeader(rawHeaders('{}'), 'content-type'),
      status: 415,
      code: 'webhook.unsupported_media_type',
    },
    {
      name: 'duplicate content type',
      headers: () => [...rawHeaders('{}'), 'content-type', 'application/json'],
      status: 415,
      code: 'webhook.unsupported_media_type',
    },
    {
      name: 'comma-folded content type',
      headers: () =>
        replaceRawHeader(
          rawHeaders('{}'),
          'content-type',
          'application/json,application/json',
        ),
      status: 415,
      code: 'webhook.unsupported_media_type',
    },
    {
      name: 'missing optional idempotency key',
      headers: () => removeRawHeader(rawHeaders('{}'), 'idempotency-key'),
      status: 202,
      code: undefined,
    },
    {
      name: 'duplicate idempotency key',
      headers: () => [...rawHeaders('{}'), 'idempotency-key', 'delivery-2'],
      status: 400,
      code: 'request.invalid',
    },
    {
      name: 'comma-folded idempotency key',
      headers: () =>
        replaceRawHeader(
          rawHeaders('{}'),
          'idempotency-key',
          'delivery-1,delivery-2',
        ),
      status: 400,
      code: 'request.invalid',
    },
  ])(
    'handles $name through raw HTTP headers',
    async ({ headers, status, code }) => {
      const { application, database } = setup();

      const response = await sendRawWebhook(application, headers(), '{}');

      expect(response.statusCode).toBe(status);
      if (code !== undefined)
        expect(JSON.parse(response.body) as { code: string }).toMatchObject({
          code,
        });
      expect(database.acceptVerifiedDelivery).toHaveBeenCalledTimes(
        status === 202 ? 1 : 0,
      );
    },
  );

  it('collapses malformed signatures and stale timestamps into one authentication response', async () => {
    const malformed = setup();
    const base = request('{}', currentSecret);
    const uppercase = await malformed.application.inject({
      ...base,
      headers: {
        ...base.headers,
        'x-pertexo-signature':
          base.headers['x-pertexo-signature'].toUpperCase(),
      },
    });
    const staleTimestamp = String(Number(timestamp) - 301);
    const stale = await malformed.application.inject({
      ...base,
      headers: {
        ...base.headers,
        'x-pertexo-timestamp': staleTimestamp,
        'x-pertexo-signature': `v1=${createHmac('sha256', currentSecret)
          .update(staleTimestamp)
          .update('.')
          .update('{}')
          .digest('hex')}`,
      },
    });
    expect(uppercase.statusCode).toBe(401);
    expect(stale.statusCode).toBe(401);
    expect(uppercase.json<{ code: string }>().code).toBe(
      'webhook.authentication_failed',
    );
    expect(stale.json<{ code: string }>().code).toBe(
      'webhook.authentication_failed',
    );
  });

  it.each([
    [{ 'content-type': 'text/plain' }, 415, 'webhook.unsupported_media_type'],
    [
      { 'content-type': 'application/jsonevil' },
      415,
      'webhook.unsupported_media_type',
    ],
    [
      { 'content-type': 'application/json; charset=latin1' },
      415,
      'webhook.unsupported_media_type',
    ],
    [
      { 'content-type': 'application/json', 'content-encoding': 'identity' },
      415,
      'webhook.unsupported_media_type',
    ],
  ])('rejects unsupported representation %#', async (extra, status, code) => {
    const { application } = setup();
    const base = request('{}', currentSecret);
    const response = await application.inject({
      ...base,
      headers: { ...base.headers, ...extra },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json<{ code: string }>().code).toBe(code);
  });

  it('accepts case-insensitive JSON media type and UTF-8 parameter', async () => {
    const { application } = setup();
    const base = request('{}', currentSecret);
    const response = await application.inject({
      ...base,
      headers: {
        ...base.headers,
        'content-type': 'APPLICATION/JSON ; CHARSET=UTF-8',
      },
    });
    expect(response.statusCode).toBe(202);
  });

  it('enforces the exact 256 KiB limit', async () => {
    const { application } = setup();
    const accepted = '{}'.padEnd(256 * 1024, ' ');
    expect(
      (await application.inject(request(accepted, currentSecret))).statusCode,
    ).toBe(202);
    const body = ' '.repeat(256 * 1024 + 1);
    const response = await application.inject(request(body, currentSecret));
    expect(response.statusCode).toBe(413);
    expect(response.json<{ code: string }>().code).toBe(
      'webhook.payload_too_large',
    );
    const parserRejected = await application.inject(
      request(' '.repeat(256 * 1024 + 10), currentSecret),
    );
    expect(parserRejected.statusCode).toBe(413);
    expect(parserRejected.json<{ code: string }>().code).toBe(
      'webhook.payload_too_large',
    );
  });

  it('accepts the eligible previous secret and rejects it at the persisted boundary', async () => {
    const first = setup();
    expect(
      (await first.application.inject(request('{}', previousSecret)))
        .statusCode,
    ).toBe(202);
    const prior = verification.previousSecret;
    if (prior === undefined)
      throw new Error('Previous secret fixture is missing');
    const second = setup({
      ...verification,
      previousSecret: { ...prior, validUntil: now },
    });
    expect(
      (await second.application.inject(request('{}', previousSecret)))
        .statusCode,
    ).toBe(401);
  });

  it('wipes the current secret when opening the eligible previous secret fails', async () => {
    const fixture = setup();
    const openedCurrent = Buffer.alloc(32, 4);
    fixture.openSecret
      .mockReset()
      .mockResolvedValueOnce(openedCurrent)
      .mockRejectedValueOnce(new Error('previous secret unavailable'));

    const response = await fixture.application.inject(
      request('{}', currentSecret),
    );

    expect(response.statusCode).toBe(503);
    expect(Array.from(openedCurrent)).toEqual(Array.from(new Uint8Array(32)));
    expect(fixture.database.acceptVerifiedDelivery).not.toHaveBeenCalled();
  });

  it('wipes both opened secret versions after signature mismatch', async () => {
    const fixture = setup();
    const base = request('{}', currentSecret);

    const response = await fixture.application.inject({
      ...base,
      headers: {
        ...base.headers,
        'x-pertexo-signature': `v1=${'0'.repeat(64)}`,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(fixture.openedSecrets).toHaveLength(2);
    for (const secret of fixture.openedSecrets)
      expect(Array.from(secret)).toEqual(Array.from(new Uint8Array(32)));
    expect(fixture.database.acceptVerifiedDelivery).not.toHaveBeenCalled();
  });

  it('maps replay mismatch and admission limits to stable corrective responses', async () => {
    const conflict = setup(undefined, new WebhookDeliveryReplayMismatchError());
    expect(
      (await conflict.application.inject(request('{}', currentSecret))).json<{
        code: string;
      }>().code,
    ).toBe('webhook.idempotency_conflict');
    const limited = setup(undefined, new WorkspaceRunQuotaExceededError());
    const response = await limited.application.inject(
      request('{}', currentSecret),
    );
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('5');

    const fenced = setup(undefined, new RegionalWriteAdmissionPausedError());
    const fencedResponse = await fenced.application.inject(
      request('{}', currentSecret),
    );
    expect(fencedResponse.statusCode).toBe(503);
    expect(fencedResponse.headers['retry-after']).toBe('5');
    expect(fencedResponse.json<{ code: string }>().code).toBe(
      'webhook.unavailable',
    );
  });

  it('fails closed for missing verification and malformed timestamp material', async () => {
    const missing = setup();
    missing.database.resolveVerification.mockResolvedValueOnce(null);
    const missingResponse = await missing.application.inject(
      request('{}', currentSecret),
    );
    expect(missingResponse.statusCode).toBe(401);
    expect(missing.openSecret).not.toHaveBeenCalled();

    const malformed = setup();
    const base = request('{}', currentSecret);
    const malformedResponse = await malformed.application.inject({
      ...base,
      headers: { ...base.headers, 'x-pertexo-timestamp': 'not-a-time' },
    });
    expect(malformedResponse.statusCode).toBe(401);
    expect(malformed.openSecret).not.toHaveBeenCalled();
  });

  it('rejects malformed idempotency headers before delivery admission', async () => {
    const { application, database } = setup();
    const base = request('{}', currentSecret);
    const response = await application.inject({
      ...base,
      headers: { ...base.headers, 'idempotency-key': 'one,two' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('request.invalid');
    expect(database.acceptVerifiedDelivery).not.toHaveBeenCalled();
  });

  it.each([
    new WebhookDeliveryIneligibleError(),
    new WorkspaceRunAdmissionDeniedError(),
  ])(
    'conceals ineligible delivery admission as authentication failure',
    async (error) => {
      const { application } = setup(undefined, error);
      const response = await application.inject(request('{}', currentSecret));
      expect(response.statusCode).toBe(401);
      expect(response.json<{ code: string }>().code).toBe(
        'webhook.authentication_failed',
      );
    },
  );

  it('returns the original run reference for an exact completed replay', async () => {
    const replay = setup(undefined, undefined, {
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: true,
    });
    const response = await replay.application.inject(
      request('{}', currentSecret),
    );
    expect(response.statusCode).toBe(202);
    expect(response.json<{ runId: string; replayed: boolean }>()).toEqual({
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: true,
    });
  });

  it('fails closed with a bounded response when infrastructure is unavailable', async () => {
    const { application, database } = setup();
    database.resolveVerification.mockRejectedValueOnce(
      new Error('sensitive database failure'),
    );

    const response = await application.inject(request('{}', currentSecret));

    expect(response.statusCode).toBe(503);
    expect(response.json<{ code: string }>()).toMatchObject({
      code: 'webhook.unavailable',
    });
    expect(response.body).not.toContain('sensitive database failure');
    expect(database.acceptVerifiedDelivery).not.toHaveBeenCalled();
  });

  it('does not persist a delivery after the client socket closes during secret opening', async () => {
    const { application, database, openSecret } = setup();
    const secretBarrier = deferred<Uint8Array>();
    let operationSignal: AbortSignal | undefined;
    openSecret.mockImplementationOnce(
      (_value: unknown, _context: unknown, signal: AbortSignal) => {
        operationSignal = signal;
        return secretBarrier.promise;
      },
    );
    await application.listen({ host: '127.0.0.1', port: 0 });
    const address = application.server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Expected a TCP listening address');

    const body = '{}';
    const input = request(body, currentSecret);
    const clientRequest = sendHttpRequest({
      host: '127.0.0.1',
      port: address.port,
      method: input.method,
      path: input.url,
      headers: {
        ...input.headers,
        'content-length': Buffer.byteLength(body),
      },
    });
    try {
      clientRequest.on('error', () => {
        // Expected when the test intentionally closes the client socket.
      });
      clientRequest.end(body);
      await vi.waitFor(() => {
        expect(openSecret).toHaveBeenCalledOnce();
      });

      clientRequest.destroy();
      await vi.waitFor(() => {
        expect(operationSignal?.aborted).toBe(true);
      });
    } finally {
      clientRequest.destroy();
      secretBarrier.resolve(new Uint8Array(32).fill(4));
      await application.close();
      const ownedIndex = applications.indexOf(application);
      if (ownedIndex >= 0) applications.splice(ownedIndex, 1);
    }
    expect(database.acceptVerifiedDelivery).not.toHaveBeenCalled();
  });

  it('propagates accepted-reply serialization failures through the scoped error handler', async () => {
    const { application, database } = setup();
    database.acceptVerifiedDelivery
      .mockResolvedValueOnce({
        runId: '99999999-9999-4999-8999-999999999999',
        replayed: false,
      })
      .mockResolvedValueOnce({
        runId: '99999999-9999-4999-8999-999999999999',
        replayed: true,
      });
    let failAcceptedReply = true;
    application.addHook('onSend', (_request, reply, payload) => {
      if (reply.statusCode === 202 && failAcceptedReply) {
        failAcceptedReply = false;
        throw new Error('simulated reply failure');
      }
      return Promise.resolve(payload);
    });

    const response = await application.inject(request('{}', currentSecret));

    expect(response.statusCode).toBe(503);
    expect(response.json<{ code: string }>().code).toBe('webhook.unavailable');
    expect(database.acceptVerifiedDelivery).toHaveBeenCalledOnce();

    const retry = await application.inject(request('{}', currentSecret));
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toEqual({
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: true,
    });
    expect(database.acceptVerifiedDelivery).toHaveBeenCalledTimes(2);
  });

  function setup(
    reference = verification,
    acceptanceError?: Error,
    acceptance = {
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: false,
    },
    includeTraceparent = true,
    telemetryOverrides: Partial<WebhookIngressTelemetry> = {},
  ) {
    const database = {
      resolveVerification: vi.fn().mockResolvedValue(reference),
      consumeIngressLimit: vi.fn().mockResolvedValue(undefined),
      acceptVerifiedDelivery: acceptanceError
        ? vi.fn().mockRejectedValue(acceptanceError)
        : vi.fn().mockResolvedValue(acceptance),
    };
    const openedSecrets: Uint8Array[] = [];
    const openSecret = vi
      .fn()
      .mockImplementation(
        (_value: unknown, context: { secretVersionId: string }) => {
          const secret = new Uint8Array(32).fill(
            context.secretVersionId === verification.currentSecret.id ? 4 : 5,
          );
          openedSecrets.push(secret);
          return Promise.resolve(secret);
        },
      );
    const encryption = {
      open: openSecret,
    } as unknown as WebhookTriggerEnvelopeEncryption;
    const delivery = vi.fn();
    const deduplication = vi.fn();
    const health = vi.fn();
    const trace = vi.fn();
    const telemetry: WebhookIngressTelemetry = {
      delivery,
      deduplication,
      health,
      traceparent: () =>
        includeTraceparent
          ? '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01'
          : undefined,
      trace: async <T>(
        _traceparent: string | undefined,
        work: () => Promise<T>,
      ) => {
        trace();
        return work();
      },
      ...telemetryOverrides,
    };
    const application = Fastify();
    applications.push(application);
    registerWebhookIngress(application, {
      database: database as unknown as WebhookTriggerDatabase,
      encryption,
      checkpointFactory: () => ({ engineVersion: 'test', checkpoint: {} }),
      telemetry,
    });
    return {
      application,
      database,
      delivery,
      deduplication,
      health,
      openSecret,
      openedSecrets,
      trace,
    };
  }
});

function request(body: string, secret: Uint8Array) {
  return {
    method: 'POST' as const,
    url: `/hooks/${endpointKey}`,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-pertexo-timestamp': timestamp,
      'x-pertexo-signature': signature(body, secret),
      'idempotency-key': 'delivery-1',
    },
    payload: body,
  };
}

function signature(body: string | Uint8Array, secret: Uint8Array): string {
  return `v1=${createHmac('sha256', secret)
    .update(timestamp)
    .update('.')
    .update(body)
    .digest('hex')}`;
}

function rawHeaders(body: string): string[] {
  return [
    'host',
    '127.0.0.1',
    'content-type',
    'application/json',
    'x-pertexo-timestamp',
    timestamp,
    'x-pertexo-signature',
    signature(body, currentSecret),
    'idempotency-key',
    'delivery-1',
    'content-length',
    String(Buffer.byteLength(body)),
  ];
}

function removeRawHeader(headers: readonly string[], name: string): string[] {
  const output: string[] = [];
  for (let index = 0; index < headers.length; index += 2) {
    if (headers[index]?.toLowerCase() === name) continue;
    output.push(headers[index] ?? '', headers[index + 1] ?? '');
  }
  return output;
}

function replaceRawHeader(
  headers: readonly string[],
  name: string,
  value: string,
): string[] {
  const output = [...headers];
  const index = output.findIndex(
    (entry, position) => position % 2 === 0 && entry.toLowerCase() === name,
  );
  if (index < 0) throw new Error(`Raw header ${name} is missing`);
  output[index + 1] = value;
  return output;
}

async function sendRawWebhook(
  application: FastifyInstance,
  headers: readonly string[],
  body: string,
): Promise<Readonly<{ statusCode: number; body: string }>> {
  if (!application.server.listening)
    await application.listen({ host: '127.0.0.1', port: 0 });
  const address = application.server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Expected a TCP listening address');
  return new Promise((resolve, reject) => {
    const client = sendHttpRequest(
      {
        host: '127.0.0.1',
        port: address.port,
        method: 'POST',
        path: `/hooks/${endpointKey}`,
        headers: [...headers],
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    client.once('error', reject);
    client.end(body);
  });
}

function sealed(id: string) {
  return {
    id,
    schemaVersion: 1 as const,
    kmsKeyReference: 'key',
    encryptedDataKey: 'key',
    ciphertext: 'ciphertext',
    nonce: 'nonce',
    authTag: 'tag',
  };
}

function deferred<T>() {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: (value: T): void => {
      settle?.(value);
      settle = undefined;
    },
  };
}
