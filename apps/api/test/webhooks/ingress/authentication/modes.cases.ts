import { expect, it } from 'vitest';

import {
  endpointKey,
  currentSecret,
  previousSecret,
  now,
  verification,
} from '../environment.js';
import { request, rawHeaders, sendRawWebhook } from '../requests.js';
import type { createIngressFixture } from '../fixture.js';

export function registerReturnsPlain202SkipVerifiedSDeliveries(
  caseFixture: ReturnType<typeof createIngressFixture>,
): void {
  const { setup, setupPreflight } = caseFixture;

  it.each(['signed', 'secret_url'] as const)(
    'returns a plain 202 skip for verified %s deliveries without opening a workflow-response wait',
    async (mode) => {
      const f = setup({
        reference: {
          ...verification,
          authentication: { mode, allowedOrigins: [] },
        },
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
      const f = setup({
        reference: { ...verification, authentication: policy },
      });
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
      const f = setup({
        reference: { ...verification, authentication: policy },
      });
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
        reference: {
          ...verification,
          authentication: {
            mode: 'header_secret',
            headerName,
            allowedOrigins: [],
          },
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
}
