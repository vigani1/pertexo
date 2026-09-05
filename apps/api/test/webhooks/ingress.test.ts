import { createHmac } from 'node:crypto';
import { request as sendHttpRequest } from 'node:http';

import type {
  WebhookTriggerDatabase,
  WebhookVerificationReference,
} from '@pertexo/database/testing';
import {
  RegionalWriteAdmissionPausedError,
  WebhookDeliveryReplayMismatchError,
  WebhookIngressRateLimitExceededError,
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

  it('enforces the exact 256 KiB limit', async () => {
    const { application } = setup();
    const accepted = '{}'.padEnd(256 * 1024, ' ');
    expect(
      (await application.inject(request(accepted, currentSecret))).statusCode,
    ).toBe(202);
    const body = ' '.repeat(256 * 1024 + 10);
    const response = await application.inject(request(body, currentSecret));
    expect(response.statusCode).toBe(413);
    expect(response.json<{ code: string }>().code).toBe(
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
    let releaseSecret: (() => void) | undefined;
    let operationSignal: AbortSignal | undefined;
    openSecret.mockImplementationOnce(
      (_value: unknown, _context: unknown, signal: AbortSignal) =>
        new Promise<Uint8Array>((resolve) => {
          operationSignal = signal;
          releaseSecret = () => {
            resolve(new Uint8Array(32).fill(4));
          };
        }),
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
    releaseSecret?.();
    await application.close();
    expect(database.acceptVerifiedDelivery).not.toHaveBeenCalled();
  });

  it('propagates accepted-reply serialization failures through the scoped error handler', async () => {
    const { application } = setup();
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
  });

  function setup(
    reference = verification,
    acceptanceError?: Error,
    acceptance = {
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: false,
    },
  ) {
    const database = {
      resolveVerification: vi.fn().mockResolvedValue(reference),
      consumeIngressLimit: vi.fn().mockResolvedValue(undefined),
      acceptVerifiedDelivery: acceptanceError
        ? vi.fn().mockRejectedValue(acceptanceError)
        : vi.fn().mockResolvedValue(acceptance),
    };
    const openSecret = vi
      .fn()
      .mockImplementation(
        (_value: unknown, context: { secretVersionId: string }) => {
          return Promise.resolve(
            new Uint8Array(32).fill(
              context.secretVersionId === verification.currentSecret.id ? 4 : 5,
            ),
          );
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
        '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      trace: async <T>(
        _traceparent: string | undefined,
        work: () => Promise<T>,
      ) => {
        trace();
        return work();
      },
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

function signature(body: string, secret: Uint8Array): string {
  return `v1=${createHmac('sha256', secret)
    .update(timestamp)
    .update('.')
    .update(body)
    .digest('hex')}`;
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
