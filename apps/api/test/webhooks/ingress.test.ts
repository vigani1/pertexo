import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { WebhookPreflightController } from '../../src/webhooks/authentication/preflight.controller.js';
import { WEBHOOK_PREFLIGHT } from '../../src/webhooks/tokens.js';
import { RateLimitModule } from '../../src/platform/rate-limit/rate-limit.module.js';
import type { RateLimitConsumer } from '../../src/platform/rate-limit/admission.js';
import { createHash, createHmac } from 'node:crypto';
import { CallableInputInvalidError } from '@pertexo/workflow-model';
import { StoredExecutionValueInvalidError } from '@pertexo/database/platform';
import { request as sendHttpRequest } from 'node:http';

import type {
  WebhookTriggerDatabase,
  WebhookVerificationReference,
} from '@pertexo/database/testing';
import {
  WebhookDeliveryIneligibleError,
  WebhookDeliveryReplayMismatchError,
  WebhookIngressRateLimitExceededError,
  WebhookWorkflowPausedError,
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
} from '@pertexo/database/testing';
import type { WebhookTriggerEnvelopeEncryption } from '@pertexo/integrations/server';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerWebhookIngress,
  createWebhookPreflight,
} from '../../src/webhooks/ingress/register.js';
import type { WebhookIngressTelemetry } from '../../src/webhooks/ingress/telemetry.js';

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
  authentication: { mode: 'signed', allowedOrigins: [] },
  currentSecret: sealed('11111111-1111-4111-8111-111111111111'),
  previousSecret: {
    ...sealed('22222222-2222-4222-8222-222222222222'),
    validUntil: new Date(now.getTime() + 1),
  },
};

type AcceptInput = Parameters<
  WebhookTriggerDatabase['acceptVerifiedDelivery']
>[0];
const acceptedInputs = (
  database: Pick<WebhookTriggerDatabase, 'acceptVerifiedDelivery'>,
): AcceptInput[] =>
  vi.mocked(database.acceptVerifiedDelivery).mock.calls.map(([input]) => input);

describe('generic webhook ingress', () => {
  const applications: FastifyInstance[] = [];
  const nestApplications: INestApplication[] = [];
  beforeEach(() => {
    currentSecret.fill(4);
    previousSecret.fill(5);
  });
  afterEach(async () => {
    await Promise.all(
      nestApplications.splice(0).map((application) => application.close()),
    );
    await Promise.all(
      applications.splice(0).map((application) => application.close()),
    );
  });

  it.each(['signed', 'secret_url'] as const)(
    'returns a plain 202 skip for verified %s deliveries without opening a workflow-response wait',
    async (mode) => {
      const f = setup({
        ...verification,
        authentication: { mode, allowedOrigins: [] },
      });
      f.database.acceptVerifiedDelivery.mockResolvedValue({
        skipped: true,
        reason: 'concurrency_limit',
      });
      const input =
        mode === 'signed'
          ? request('{}', currentSecret)
          : {
              method: 'POST' as const,
              url: `/hooks/${endpointKey}`,
              headers: { 'content-type': 'application/json' },
              payload: '{}',
            };
      const response = await f.application.inject(input);
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        skipped: true,
        reason: 'concurrency_limit',
      });
      expect(f.database.acceptVerifiedDelivery).toHaveBeenCalledOnce();
      expect(f.database.readResponse).not.toHaveBeenCalled();
      expect(f.database.recordRejectedDelivery).not.toHaveBeenCalled();
      expect(f.delivery).toHaveBeenCalledWith('skipped');
    },
  );
  it.each(['secret_url', 'header_secret'] as const)(
    'authenticates %s without a Pertexo signature',
    async (mode) => {
      const policy =
        mode === 'secret_url'
          ? { mode, allowedOrigins: [] }
          : { mode, headerName: 'authorization', allowedOrigins: [] };
      const f = setup({ ...verification, authentication: policy });
      const result = await f.application.inject({
        method: 'POST',
        url: `/hooks/${endpointKey}`,
        headers: {
          'content-type': 'application/json',
          ...(mode === 'header_secret'
            ? {
                authorization: `Bearer ${Buffer.from(currentSecret).toString('base64url')}`,
              }
            : {}),
        },
        payload: '{}',
      });
      expect(result.statusCode).toBe(202);
      expect(f.database.acceptVerifiedDelivery).toHaveBeenCalledOnce();
      if (mode === 'secret_url') expect(f.openedSecrets).toHaveLength(0);
      else
        expect(
          f.openedSecrets.every((secret) => secret.every((byte) => byte === 0)),
        ).toBe(true);
    },
  );
  it.each(['authorization', 'x-webhook-secret'])(
    'accepts current and overlapping previous header secrets in %s, refusing missing/wrong/expired ones',
    async (headerName) => {
      const policy = {
        mode: 'header_secret' as const,
        headerName,
        allowedOrigins: [],
      };
      const f = setup({ ...verification, authentication: policy });
      const send = (secret: Uint8Array | undefined) =>
        f.application.inject({
          method: 'POST',
          url: `/hooks/${endpointKey}`,
          headers: {
            'content-type': 'application/json',
            ...(secret === undefined
              ? {}
              : {
                  [headerName]: `${headerName === 'authorization' ? 'Bearer ' : ''}${Buffer.from(secret).toString('base64url')}`,
                }),
          },
          payload: '{}',
        });
      expect((await send(currentSecret)).statusCode).toBe(202);
      expect((await send(previousSecret)).statusCode).toBe(202);
      expect((await send(undefined)).statusCode).toBe(401);
      expect((await send(new Uint8Array(32).fill(19))).statusCode).toBe(401);
      const previous = verification.previousSecret;
      if (previous === undefined) throw new Error('Previous fixture missing');
      f.database.resolveVerification.mockResolvedValue({
        ...verification,
        authentication: policy,
        previousSecret: { ...previous, validUntil: now },
      });
      expect((await send(previousSecret)).statusCode).toBe(401);
    },
  );
  it.each(['authorization', 'x-webhook-secret'])(
    'refuses duplicate and comma-folded %s credentials on the wire',
    async (headerName) => {
      const f = setup({
        ...verification,
        authentication: {
          mode: 'header_secret',
          headerName,
          allowedOrigins: [],
        },
      });
      const value = `${headerName === 'authorization' ? 'Bearer ' : ''}${Buffer.from(currentSecret).toString('base64url')}`;
      for (const headers of [
        [...rawHeaders('{}'), headerName, value, headerName, value],
        [...rawHeaders('{}'), headerName, `${value},${value}`],
      ])
        expect(
          (await sendRawWebhook(f.application, headers, '{}')).statusCode,
        ).toBe(401);
      expect(f.database.acceptVerifiedDelivery).not.toHaveBeenCalled();
    },
  );
  it('handles endpoint-only preflight without decrypting, logging a delivery or starting a run', async () => {
    const f = await setupPreflight({
      ...verification,
      authentication: {
        mode: 'header_secret',
        headerName: 'x-webhook-secret',
        allowedOrigins: ['https://app.example'],
      },
    });
    const response = await f.application.inject({
      method: 'OPTIONS',
      url: `/hooks/${endpointKey}`,
      headers: {
        origin: 'https://app.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers':
          'Content-Type, X-Webhook-Secret, Idempotency-Key',
      },
    });
    expect(f.consume).toHaveBeenCalledOnce();
    expect(f.consume.mock.calls[0]?.[0]).toMatchObject({
      endpointClass: 'webhook_preflight',
      failureMode: 'closed',
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers).toMatchObject({
      'access-control-allow-origin': 'https://app.example',
      'access-control-allow-methods': 'GET, POST',
      'access-control-allow-headers':
        'content-type, x-webhook-secret, idempotency-key',
    });
    expect(
      response.headers['access-control-allow-credentials'],
    ).toBeUndefined();
    expect(f.database.acceptVerifiedDelivery).not.toHaveBeenCalled();
    expect(f.database.recordRejectedDelivery).not.toHaveBeenCalled();
    expect(f.openedSecrets).toHaveLength(0);
  });
  it('returns a safe unavailable response when preflight discovery fails', async () => {
    const f = await setupPreflight();
    f.database.resolveVerification.mockRejectedValueOnce(
      new Error('private database failure'),
    );
    const result = await f.application.inject({
      method: 'OPTIONS',
      url: `/hooks/${endpointKey}`,
      headers: {
        origin: 'https://app.example',
        'access-control-request-method': 'POST',
      },
    });
    expect(result.statusCode).toBe(503);
    expect(result.json()).toMatchObject({ code: 'webhook.unavailable' });
    expect(result.body).not.toContain('private database failure');
    expect(result.headers['access-control-allow-origin']).toBeUndefined();
    expect(f.database.acceptVerifiedDelivery).not.toHaveBeenCalled();
  });
  it('keeps preflight storage read-only and refuses unknown endpoints, origins, methods and unsupported headers', async () => {
    const f = await setupPreflight({
      ...verification,
      authentication: {
        mode: 'secret_url',
        allowedOrigins: ['https://app.example'],
      },
    });
    const base = {
      method: 'OPTIONS' as const,
      url: `/hooks/${endpointKey}`,
      headers: {
        origin: 'https://app.example',
        'access-control-request-method': 'POST',
      },
    };
    for (const extra of [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { 'access-control-request-method': 'PUT' },
      { 'access-control-request-headers': 'authorization' },
    ]) {
      const result = await f.application.inject({
        ...base,
        headers: { ...base.headers, ...extra },
      });
      expect(result.statusCode).toBe(401);
      expect(result.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect(f.database.consumeIngressLimit).not.toHaveBeenCalled();
    f.database.resolveVerification.mockResolvedValueOnce(null);
    expect((await f.application.inject(base)).statusCode).toBe(401);
    expect(f.database.acceptVerifiedDelivery).not.toHaveBeenCalled();
  });
  it('adds exact CORS origin to 202 and workflow replies; refuses other browser origins before admission', async () => {
    const f = setup({
      ...verification,
      authentication: {
        mode: 'secret_url',
        allowedOrigins: ['https://app.example'],
      },
    });
    const send = (origin: string) =>
      f.application.inject({
        method: 'POST',
        url: `/hooks/${endpointKey}`,
        headers: { origin, 'content-type': 'application/json' },
        payload: '{}',
      });
    const accepted = await send('https://app.example');
    expect(accepted.statusCode).toBe(202);
    expect(accepted.headers['access-control-allow-origin']).toBe(
      'https://app.example',
    );
    f.database.acceptVerifiedDelivery.mockResolvedValueOnce({
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: false,
      responseWaitSeconds: 1,
    });
    f.database.readResponse.mockResolvedValueOnce({
      state: 'responded',
      response: {
        statusCode: 200,
        contentType: 'text/csv',
        body: 'a,b\n1,2',
        headers: { 'x-total-count': '1' },
      },
    });
    const reply = await send('https://app.example');
    expect(reply.body).toBe('a,b\n1,2');
    expect(reply.headers['access-control-allow-origin']).toBe(
      'https://app.example',
    );
    expect(reply.headers['access-control-allow-credentials']).toBeUndefined();
    expect((await send('https://evil.example')).statusCode).toBe(401);
    expect(f.database.acceptVerifiedDelivery).toHaveBeenCalledTimes(2);
  });
  it.each([
    {
      name: 'callable input contract',
      error: new CallableInputInvalidError({
        code: 'type_mismatch',
        path: ['private-name'],
      }),
    },
    {
      name: 'stored JSON bounds',
      error: new StoredExecutionValueInvalidError(),
    },
  ])(
    'returns a safe 400 when a signed delivery violates $name',
    async ({ error }) => {
      const { application, database } = setup();
      database.acceptVerifiedDelivery.mockRejectedValue(error);
      const response = await application.inject(
        request('{"private-name":"private-value"}', currentSecret),
      );
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'request.invalid' });
      expect(response.payload).not.toContain('private-name');
      expect(response.payload).not.toContain('private-value');
    },
  );

  it('returns the committed JSON response without serializing its bytes again', async () => {
    const f = setup();
    f.database.acceptVerifiedDelivery.mockResolvedValue({
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: false,
      responseWaitSeconds: 1,
    });
    f.database.readResponse.mockResolvedValue({
      state: 'responded',
      response: {
        statusCode: 201,
        contentType: 'application/json',
        body: '{"message":"hello"}',
        headers: { 'x-request-id': 'response-1' },
      },
    });
    const result = await f.application.inject(request('{}', currentSecret));
    expect(result.statusCode).toBe(201);
    expect(result.body).toBe('{"message":"hello"}');
    expect(result.headers).toMatchObject({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-request-id': 'response-1',
    });
    expect(f.database.acceptVerifiedDelivery).toHaveBeenCalledOnce();
  });
  it.each([
    { statusCode: 200, body: 'hello 👋\n' },
    { statusCode: 204, body: '' },
  ])(
    'returns exact text and empty-body responses ($statusCode)',
    async ({ statusCode, body }) => {
      const f = setup();
      f.database.acceptVerifiedDelivery.mockResolvedValue({
        runId: '99999999-9999-4999-8999-999999999999',
        replayed: false,
        responseWaitSeconds: 1,
      });
      f.database.readResponse.mockResolvedValue({
        state: 'responded',
        response: { statusCode, contentType: 'text/plain', body, headers: {} },
      });
      const result = await f.application.inject(request('{}', currentSecret));
      expect(result.statusCode).toBe(statusCode);
      expect(result.body).toBe(body);
    },
  );
  it.each(['text/csv', 'application/xml'] as const)(
    'returns exact UTF-8 bytes with an explicit charset for %s',
    async (contentType) => {
      const f = setup();
      f.database.acceptVerifiedDelivery.mockResolvedValueOnce({
        runId: '99999999-9999-4999-8999-999999999999',
        replayed: false,
        responseWaitSeconds: 1,
      });
      f.database.readResponse.mockResolvedValueOnce({
        state: 'responded',
        response: {
          statusCode: 200,
          contentType,
          headers: { 'x-total-count': '1' },
          body: 'héllo',
        },
      });
      const result = await f.application.inject(request('{}', currentSecret));
      expect(result.statusCode).toBe(200);
      expect(result.headers['content-type']).toBe(
        `${contentType}; charset=utf-8`,
      );
      expect(result.body).toBe('héllo');
    },
  );
  it('returns only a safe code when the run fails before replying', async () => {
    const f = setup();
    f.database.acceptVerifiedDelivery.mockResolvedValue({
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: false,
      responseWaitSeconds: 1,
    });
    f.database.readResponse.mockResolvedValue({ state: 'failed' });
    const result = await f.application.inject(request('{}', currentSecret));
    expect(result.statusCode).toBe(500);
    expect(result.json()).toEqual({ code: 'webhook.workflow_failed' });
    expect(f.database.recordRejectedDelivery).not.toHaveBeenCalled();
  });
  it('falls back to the accepted receipt on timeout without canceling or rejecting the run', async () => {
    const f = setup();
    f.database.acceptVerifiedDelivery.mockResolvedValue({
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: false,
      responseWaitSeconds: 1,
    });
    const result = await f.application.inject(request('{}', currentSecret));
    expect(result.statusCode).toBe(202);
    expect(result.json()).toEqual({
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: false,
    });
    expect(f.database.recordRejectedDelivery).not.toHaveBeenCalled();
    expect(f.database.acceptVerifiedDelivery).toHaveBeenCalledOnce();
  });
  it('keeps a committed admission when the response read fails', async () => {
    const f = setup();
    f.database.acceptVerifiedDelivery.mockResolvedValue({
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: false,
      responseWaitSeconds: 1,
    });
    f.database.readResponse.mockRejectedValue(
      new Error('private stored response'),
    );
    const result = await f.application.inject(request('{}', currentSecret));
    expect(result.statusCode).toBe(202);
    expect(result.body).not.toContain('private');
    expect(f.database.recordRejectedDelivery).not.toHaveBeenCalled();
    expect(f.health).toHaveBeenLastCalledWith('degraded');
  });
  it('does not truncate a one-MiB committed response', async () => {
    const f = setup();
    f.database.acceptVerifiedDelivery.mockResolvedValue({
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: true,
      responseWaitSeconds: 1,
    });
    const body = 'x'.repeat(1_048_576);
    f.database.readResponse.mockResolvedValue({
      state: 'responded',
      response: {
        statusCode: 200,
        contentType: 'text/plain',
        body,
        headers: {},
      },
    });
    const result = await f.application.inject(request('{}', currentSecret));
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe(body);
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
        traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      }),
    );
    expect(acceptedInputs(database)[0]?.runInput).toEqual({ value: 1 });
    expect(database.consumeIngressLimit).toHaveBeenCalledOnce();
    expect(database.readResponse).not.toHaveBeenCalled();
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
        throw new Error('trace failed before callback');
      },
    },
    {
      name: 'a trace rejection before the callback',
      trace: <T>(
        _parent: string | undefined,
        _work: () => Promise<T>,
      ): Promise<T> => {
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
    [{ 'content-type': 'text/html' }, 415, 'webhook.unsupported_media_type'],
    [
      { 'content-type': 'multipart/form-data; boundary=x' },
      415,
      'webhook.unsupported_media_type',
    ],
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

  describe('request shapes', () => {
    const open = () =>
      setup({
        ...verification,
        authentication: { mode: 'secret_url', allowedOrigins: [] },
      });
    const accepted = (f: ReturnType<typeof setup>) =>
      acceptedInputs(f.database);

    it('reads form fields, plain text, +json and an empty POST', async () => {
      const f = open();
      const send = (headers: Record<string, string>, payload: string) =>
        f.application.inject({
          method: 'POST',
          url: `/hooks/${endpointKey}`,
          headers,
          payload,
        });
      for (const [headers, payload] of [
        [
          { 'content-type': 'application/x-www-form-urlencoded' },
          'name=Ada+L&tag=a&tag=b&note=%E2%9C%93',
        ],
        [{ 'content-type': 'text/plain; charset=utf-8' }, 'hello\nthere'],
        [{ 'content-type': 'application/cloudevents+json' }, '{"id":"e1"}'],
        [{}, ''],
      ] as const)
        expect((await send(headers, payload)).statusCode).toBe(202);
      expect(accepted(f).map((input) => input.runInput)).toEqual([
        { name: 'Ada L', tag: ['a', 'b'], note: '✓' },
        'hello\nthere',
        { id: 'e1' },
        {},
      ]);
      expect((await send({}, '{}')).statusCode).toBe(415);
      const latin = await f.application.inject({
        method: 'POST',
        url: `/hooks/${endpointKey}`,
        headers: { 'content-type': 'text/plain' },
        payload: Buffer.from([0xff, 0xfe]),
      });
      expect(latin.statusCode).toBe(400);
      expect(latin.json<{ code: string }>().code).toBe('request.invalid');
    });

    it('starts a GET run from the query and keeps queries apart', async () => {
      const f = open();
      const get = (query: string) =>
        f.application.inject({
          method: 'GET',
          url: `/hooks/${endpointKey}${query}`,
        });
      expect((await get('?order=A-1&tag=x&tag=y')).statusCode).toBe(202);
      expect((await get('?order=A-2')).statusCode).toBe(202);
      expect((await get('?order=A-1&tag=x&tag=y')).statusCode).toBe(202);
      const [first, second, third] = accepted(f);
      expect(first?.runInput).toEqual({ order: 'A-1', tag: ['x', 'y'] });
      expect(first?.requestFingerprint).not.toBe(second?.requestFingerprint);
      expect(first?.requestFingerprint).toBe(third?.requestFingerprint);
      expect(
        (
          await f.application.inject({
            method: 'HEAD',
            url: `/hooks/${endpointKey}`,
          })
        ).statusCode,
      ).toBe(404);
      expect(accepted(f)).toHaveLength(3);
    });

    it('refuses GET on a signed endpoint, whose signature covers a body', async () => {
      const f = setup();
      const response = await f.application.inject({
        method: 'GET',
        url: `/hooks/${endpointKey}?order=A-1`,
      });
      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe('POST');
      expect(response.json<{ code: string }>().code).toBe(
        'webhook.method_not_allowed',
      );
      expect(f.database.recordRejectedDelivery).toHaveBeenCalledOnce();
      expect(f.database.acceptVerifiedDelivery).not.toHaveBeenCalled();
    });

    it('keeps the fingerprint of a JSON POST as it was', async () => {
      const f = open();
      await f.application.inject({
        method: 'POST',
        url: `/hooks/${endpointKey}`,
        headers: { 'content-type': 'Application/JSON' },
        payload: '{"a":1}',
      });
      await f.application.inject({
        method: 'POST',
        url: `/hooks/${endpointKey}?source=shop`,
        headers: { 'content-type': 'application/json' },
        payload: '{"a":1}',
      });
      const sha = (value: string) =>
        createHash('sha256').update(value).digest('hex');
      const [plain, withQuery] = accepted(f);
      expect(plain?.requestFingerprint).toBe(
        sha(`${verification.endpointId}\0${sha('{"a":1}')}\0application/json`),
      );
      expect(withQuery?.requestFingerprint).not.toBe(plain?.requestFingerprint);
    });

    it('leaves credentials, signatures and proxy headers out of the request', async () => {
      const f = setup({
        ...verification,
        runInputMode: 'request',
        authentication: {
          mode: 'header_secret',
          headerName: 'x-webhook-secret',
          allowedOrigins: [],
        },
      });
      const response = await f.application.inject({
        method: 'POST',
        url: `/hooks/${endpointKey}`,
        headers: {
          'content-type': 'application/json',
          'x-webhook-secret': Buffer.from(currentSecret).toString('base64url'),
          authorization: 'Bearer other',
          cookie: 'session=1',
          'x-forwarded-for': '203.0.113.9',
          'x-shop-event': 'order.paid',
          'user-agent': 'shop/1',
        },
        payload: '{}',
      });
      expect(response.statusCode).toBe(202);
      const input = accepted(f)[0]?.runInput;
      expect(input).toMatchObject({
        headers: {
          'x-shop-event': 'order.paid',
          'user-agent': 'shop/1',
          'content-type': 'application/json',
        },
      });
      for (const name of [
        'x-webhook-secret',
        'authorization',
        'cookie',
        'x-forwarded-for',
      ])
        expect(input).not.toHaveProperty(`headers.${name}`);
    });
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

    const paused = setup(undefined, new WebhookWorkflowPausedError());
    const pausedResponse = await paused.application.inject(
      request('{}', currentSecret),
    );
    expect(pausedResponse.statusCode).toBe(423);
    expect(pausedResponse.json<{ code: string }>().code).toBe(
      'webhook.workflow_paused',
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

  describe('delivery log (ADR 045)', () => {
    const endpoint = {
      workspaceId: verification.workspaceId,
      triggerId: verification.triggerId,
      endpointId: verification.endpointId,
    };
    const stale = String(Number(timestamp) - 301);
    const staleSignature = `v1=${createHmac('sha256', currentSecret)
      .update(stale)
      .update('.')
      .update('{}')
      .digest('hex')}`;
    const mismatch = `v1=${'0'.repeat(64)}`;
    const verified = { signatureCheck: 'verified' } as const;
    type Scenario = Readonly<{
      name: string;
      headers?: Readonly<Record<string, string>>;
      body?: string;
      acceptanceError?: Error;
      status: number;
      fact: Readonly<Record<string, string>>;
    }>;

    it.each<Scenario>([
      {
        name: 'a stale timestamp',
        headers: {
          'x-pertexo-timestamp': stale,
          'x-pertexo-signature': staleSignature,
        },
        status: 401,
        fact: {
          outcome: 'authentication_failed',
          signatureCheck: 'not_checked',
          replayCheck: 'stale_timestamp',
        },
      },
      {
        name: 'a signature mismatch',
        headers: { 'x-pertexo-signature': mismatch },
        status: 401,
        fact: {
          outcome: 'authentication_failed',
          signatureCheck: 'mismatch',
          replayCheck: 'not_checked',
        },
      },
      {
        name: 'malformed JSON',
        body: '{',
        status: 400,
        fact: {
          ...verified,
          outcome: 'invalid_request',
          replayCheck: 'not_checked',
        },
      },
      {
        name: 'a malformed idempotency key',
        headers: { 'idempotency-key': 'one,two' },
        status: 400,
        fact: {
          ...verified,
          outcome: 'invalid_request',
          replayCheck: 'not_checked',
        },
      },
      {
        name: 'an idempotency conflict',
        acceptanceError: new WebhookDeliveryReplayMismatchError(),
        status: 409,
        fact: { ...verified, outcome: 'conflict', replayCheck: 'conflict' },
      },
      {
        name: 'run admission throttling',
        acceptanceError: new WorkspaceRunQuotaExceededError(),
        status: 429,
        fact: { ...verified, outcome: 'rate_limited', replayCheck: 'new' },
      },
      {
        name: 'a paused workflow',
        acceptanceError: new WebhookWorkflowPausedError(),
        status: 423,
        fact: { ...verified, outcome: 'paused', replayCheck: 'new' },
      },
      {
        name: 'an endpoint that stopped accepting',
        acceptanceError: new WebhookDeliveryIneligibleError(),
        status: 401,
        fact: {
          ...verified,
          outcome: 'authentication_failed',
          replayCheck: 'new',
        },
      },
    ])('records $name as metadata with the same response', async (scenario) => {
      const body = scenario.body ?? '{}';
      const fixture = setup(undefined, scenario.acceptanceError);
      const base = request(body, currentSecret);
      const response = await fixture.application.inject({
        ...base,
        headers: { ...base.headers, ...scenario.headers },
      });

      expect(response.statusCode).toBe(scenario.status);
      expect(
        fixture.database.recordRejectedDelivery,
      ).toHaveBeenCalledExactlyOnceWith({
        endpoint,
        ...scenario.fact,
        bodyBytes: Buffer.byteLength(body),
      });
    });

    it('records nothing it cannot attribute', async () => {
      const unknown = setup();
      unknown.database.resolveVerification.mockResolvedValueOnce(null);
      const limited = setup();
      limited.database.consumeIngressLimit.mockRejectedValueOnce(
        new WebhookIngressRateLimitExceededError(3),
      );
      const accepted = setup();
      const fixtures = [unknown, limited, accepted];
      const responses = await Promise.all(
        fixtures.map(({ application }) =>
          application.inject(request('{"size":1}', currentSecret)),
        ),
      );

      expect(responses.map(({ statusCode }) => statusCode)).toEqual([
        401, 429, 202,
      ]);
      for (const fixture of fixtures)
        expect(fixture.database.recordRejectedDelivery).not.toHaveBeenCalled();
      expect(accepted.database.acceptVerifiedDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ bodyBytes: 10 }),
      );
    });

    it('keeps the response when the delivery log cannot be written', async () => {
      const fixture = setup();
      fixture.database.recordRejectedDelivery.mockRejectedValueOnce(
        new Error('delivery log unavailable'),
      );
      const base = request('{}', currentSecret);
      const response = await fixture.application.inject({
        ...base,
        headers: { ...base.headers, 'x-pertexo-signature': mismatch },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json<{ code: string }>().code).toBe(
        'webhook.authentication_failed',
      );
      expect(response.body).not.toContain('delivery log unavailable');
    });
  });

  async function setupPreflight(reference = verification) {
    const fixture = setup(reference);
    const consume = vi
      .fn<RateLimitConsumer['consume']>()
      .mockResolvedValue({ allowed: true });
    const testing = await Test.createTestingModule({
      imports: [RateLimitModule.register('redis://unused', { consume })],
      controllers: [WebhookPreflightController],
      providers: [
        {
          provide: WEBHOOK_PREFLIGHT,
          useValue: createWebhookPreflight(fixture.dependencies),
        },
      ],
    }).compile();
    const application = testing.createNestApplication(
      new FastifyAdapter(fixture.application),
    );
    nestApplications.push(application);
    applications.splice(applications.indexOf(fixture.application), 1);
    await application.init();
    return { ...fixture, consume };
  }

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
      readResponse: vi
        .fn<WebhookTriggerDatabase['readResponse']>()
        .mockResolvedValue({ state: 'pending' }),
      resolveVerification: vi.fn().mockResolvedValue(reference),
      consumeIngressLimit: vi.fn().mockResolvedValue(undefined),
      acceptVerifiedDelivery: acceptanceError
        ? vi.fn().mockRejectedValue(acceptanceError)
        : vi.fn().mockResolvedValue(acceptance),
      recordRejectedDelivery: vi.fn().mockResolvedValue(undefined),
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
    const dependencies = {
      database: database as unknown as WebhookTriggerDatabase,
      encryption,
      checkpointFactory: () => ({ checkpoint: {} }),
      telemetry,
    };
    registerWebhookIngress(application, dependencies);
    return {
      dependencies,
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
