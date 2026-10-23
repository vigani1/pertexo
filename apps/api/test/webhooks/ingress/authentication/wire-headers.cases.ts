import { createHmac } from 'node:crypto';

import { expect, it } from 'vitest';

import { currentSecret, timestamp } from '../environment.js';
import {
  request,
  signature,
  rawHeaders,
  removeRawHeader,
  replaceRawHeader,
  sendRawWebhook,
} from '../requests.js';
import type { createIngressFixture } from '../fixture.js';

export function registerHandlesNameThroughRawHTTPHeaders(
  caseFixture: ReturnType<typeof createIngressFixture>,
): void {
  const { setup } = caseFixture;

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
      const { application, database } = setup({});

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
    const malformed = setup({});
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
    const { application } = setup({});
    const base = request('{}', currentSecret);
    const response = await application.inject({
      ...base,
      headers: { ...base.headers, ...extra },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json<{ code: string }>().code).toBe(code);
  });
}
