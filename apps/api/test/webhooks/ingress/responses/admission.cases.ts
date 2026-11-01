import { WebhookIngressRateLimitExceededError } from '@pertexo/core/testing';

import { expect, it } from 'vitest';

import { endpointKey, currentSecret, timestamp } from '../environment.js';
import { request, signature } from '../requests.js';
import type { createIngressFixture } from '../fixture.js';

export function registerReturnsOneAuthoritativeAcceptanceTracingInvokesCallback(
  caseFixture: ReturnType<typeof createIngressFixture>,
): void {
  const { setup } = caseFixture;

  it('returns one authoritative acceptance when tracing invokes its callback twice', async () => {
    let firstPromise: Promise<unknown> | undefined;
    const fixture = setup({
      reference: undefined,
      acceptanceError: undefined,
      acceptance: undefined,
      includeTraceparent: true,
      telemetryOverrides: {
        trace: <T>(_parent: string | undefined, work: () => Promise<T>) => {
          const first = work();
          const second = work();
          firstPromise = first;
          expect(second).toBe(first);
          return first;
        },
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
    const fixture = setup({
      reference: undefined,
      acceptanceError: undefined,
      acceptance: undefined,
      includeTraceparent: true,
      telemetryOverrides: {
        traceparent: () => {
          throw new Error('active trace context is unavailable');
        },
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
    const fixture = setup({
      reference: undefined,
      acceptanceError: workFailure,
      acceptance: undefined,
      includeTraceparent: true,
      telemetryOverrides: {
        trace: <T>(_parent: string | undefined, work: () => Promise<T>) => {
          void work();
          return Promise.reject(new Error('trace export unavailable'));
        },
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
    const { application, database, openSecret } = setup({});
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
    const { application, database } = setup({});
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
    const { application, database } = setup({});
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
}
