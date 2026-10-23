import { expect, it, vi } from 'vitest';

import type { WebhookIngressTelemetry } from '../../../../src/webhooks/ingress/telemetry.js';
import { currentSecret } from '../environment.js';
import { request } from '../requests.js';
import { acceptedInputs } from '../acceptance.js';
import type { createIngressFixture } from '../fixture.js';

export function registerFallsBackAcceptedReceiptOnTimeoutWithout(
  caseFixture: ReturnType<typeof createIngressFixture>,
): void {
  const { setup } = caseFixture;

  it('falls back to the accepted receipt on timeout without canceling or rejecting the run', async () => {
    const f = setup({});
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
    const f = setup({});
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
    const f = setup({});
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
      setup({});
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
    const fixture = setup({
      reference: undefined,
      acceptanceError: undefined,
      acceptance: undefined,
      includeTraceparent: false,
    });
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
    const fixture = setup({
      reference: undefined,
      acceptanceError: undefined,
      acceptance: undefined,
      includeTraceparent: true,
      telemetryOverrides: { trace },
    });

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
}
