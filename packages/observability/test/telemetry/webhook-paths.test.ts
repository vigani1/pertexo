import type { IncomingMessage } from 'node:http';
import type { UndiciRequest } from '@opentelemetry/instrumentation-undici';
import { it, expect } from 'vitest';
import {
  sanitizeIncomingHttpRequest,
  sanitizeNestSpanOptions,
  sanitizeOutgoingHttpRequest,
  sanitizeUndiciRequest,
} from '../../src/telemetry/sanitization.js';

it('removes webhook address credentials from incoming and outgoing telemetry', () => {
  const secret = 'a'.repeat(43);
  const path = `/hooks/${secret}?retry=1`;
  const values = [
    sanitizeIncomingHttpRequest({
      url: path,
      headers: { host: 'api.example' },
    } as IncomingMessage),
    sanitizeOutgoingHttpRequest({
      path,
      hostname: 'api.example',
      protocol: 'https:',
    }),
    sanitizeUndiciRequest({
      path,
      origin: 'https://api.example',
    } as UndiciRequest),
  ];
  expect(values[0]?.['url.path']).toBe('unmatched');
  expect(values[1]?.['url.path']).toBeUndefined();
  expect(values[2]?.['url.path']).toBeUndefined();
  for (const value of values) {
    expect(JSON.stringify(value)).not.toContain(secret);
  }
});

// S13: Nest's own request span records the address as sent.
it('keeps a query out of the address on a Nest span', () => {
  expect(
    sanitizeNestSpanOptions({
      attributes: {
        'http.route': '/v1/connections/oauth2/callback',
        'url.full': '/v1/connections/oauth2/callback?code=the-code&state=s',
      },
    }).attributes,
  ).toEqual({
    'http.route': '/v1/connections/oauth2/callback',
    'url.full': '/v1/connections/oauth2/callback',
    'url.path': '/v1/connections/oauth2/callback',
  });
  expect(sanitizeNestSpanOptions({ attributes: {} }).attributes).toEqual({});
});
