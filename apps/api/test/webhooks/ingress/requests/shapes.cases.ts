import { createHash } from 'node:crypto';

import { expect, it } from 'vitest';

import { endpointKey, currentSecret, verification } from '../environment.js';
import type { createRequestShapeFixture } from '../examples.js';

export function registerReadsFormFieldsPlainTextJsonEmpty(
  caseFixture: ReturnType<typeof createRequestShapeFixture>,
): void {
  const { open, accepted, setup } = caseFixture;

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
    const f = setup({});
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
      reference: {
        ...verification,
        runInputMode: 'request',
        authentication: {
          mode: 'header_secret',
          headerName: 'x-webhook-secret',
          allowedOrigins: [],
        },
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
}
