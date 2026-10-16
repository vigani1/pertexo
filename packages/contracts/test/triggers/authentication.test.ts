import { describe, it, expect } from 'vitest';
import { webhookAuthenticationSchema } from '../../src/index.js';

describe('webhook authentication policy', () => {
  it.each([
    'https://example.com',
    'http://localhost:5173',
    'https://[::1]:1234',
  ])('allows exact origin %s', (origin) => {
    expect(
      webhookAuthenticationSchema.parse({
        mode: 'secret_url',
        allowedOrigins: [origin],
      }).allowedOrigins,
    ).toEqual([origin]);
  });
  it.each([
    '*',
    'null',
    'https://*.example.com',
    'https://example.com/',
    'https://example.com/path',
    'https://user@example.com',
    'https://example.com?x=1',
    'https://example.com#x',
    'https://EXAMPLE.com',
    'javascript:alert(1)',
  ])('refuses unsafe/non-origin %s', (origin) => {
    expect(
      webhookAuthenticationSchema.safeParse({
        mode: 'secret_url',
        allowedOrigins: [origin],
      }).success,
    ).toBe(false);
  });
  it.each([
    'host',
    'cookie',
    'content-type',
    'x-forwarded-for',
    'origin',
    'x-pertexo-signature',
    'access-control-allow-origin',
    'sec-fetch-site',
    'traceparent',
    'idempotency-key',
    'x-request-id',
    "x-'secret",
    'Authorization',
  ])('refuses reserved or malformed header %s', (headerName) => {
    expect(
      webhookAuthenticationSchema.safeParse({
        mode: 'header_secret',
        headerName,
        allowedOrigins: [],
      }).success,
    ).toBe(false);
  });
  it.each(['authorization', 'x-webhook-secret', 'api-key'])(
    'allows dedicated header %s',
    (headerName) => {
      expect(
        webhookAuthenticationSchema.parse({
          mode: 'header_secret',
          headerName,
          allowedOrigins: [],
        }).mode,
      ).toBe('header_secret');
    },
  );
  it('does not allow browser origins in Signed mode or duplicate/unbounded origins', () => {
    for (const value of [
      { mode: 'signed', allowedOrigins: ['https://a.test'] },
      {
        mode: 'secret_url',
        allowedOrigins: ['https://a.test', 'https://a.test'],
      },
      {
        mode: 'secret_url',
        allowedOrigins: Array.from(
          { length: 21 },
          (_, i) => `https://a${String(i)}.test`,
        ),
      },
    ])
      expect(webhookAuthenticationSchema.safeParse(value).success).toBe(false);
  });
});
