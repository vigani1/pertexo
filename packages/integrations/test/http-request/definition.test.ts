import { DISPATCH_AWARE_EXECUTOR_ABI_VERSION } from '@pertexo/node-sdk/server';
import { describe, expect, it } from 'vitest';
import {
  HTTP_REQUEST_CONNECTION_SLOT,
  HTTP_REQUEST_DEFINITION_REGISTRATION,
  HTTP_REQUEST_MANIFEST,
  httpRequestConfigSchema,
  httpRequestInputSchema,
} from '../../src/index.js';

import { config } from '../support/http-execution.js';
describe('http.request@1 definition', () => {
  it('is browser-safe, exact, conservative, and release-ready', () => {
    expect(HTTP_REQUEST_MANIFEST).toMatchObject({
      definition: { key: 'http.request', version: 1 },
      executor: { key: 'http.request', version: 1 },
      executorAbi: DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
      retryClass: 'unsafe',
      resourceClass: 'io',
      connectionRequirements: [HTTP_REQUEST_CONNECTION_SLOT],
      credentialRequirements: [HTTP_REQUEST_CONNECTION_SLOT],
      integration: { providerKey: 'http', operationKey: 'request' },
    });
    expect(HTTP_REQUEST_MANIFEST.capabilities).toEqual([
      'external_http',
      'artifact_output',
      'artifact_input',
      'side_effect_disclosure',
    ]);
    expect(Object.isFrozen(HTTP_REQUEST_MANIFEST)).toBe(true);
  });

  it('rejects unknown fields, credential-like headers, bad URLs, and limit overflow', () => {
    expect(httpRequestConfigSchema.safeParse(config()).success).toBe(true);
    for (const candidate of [
      config({ authorization: 'secret' }),
      config({ headers: { authorization: 'secret' } }),
      config({ headers: { 'x-api-key': 'secret' } }),
      config({ headers: { host: 'metadata.internal' } }),
      config({ url: 'file:///etc/passwd' }),
      config({ url: 'https://user:secret@example.test/' }),
      config({ url: 'https://example.test/?api_key=secret' }),
      config({ timeoutMillis: 120_001 }),
      config({ maxRedirects: 6 }),
      config({ maxResponseBytes: 10_485_761 }),
      config({ maxResponseBytes: 1_024, inlineResponseBytes: 2_048 }),
      config({
        headers: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`x-${String(index)}`, 'x']),
        ),
      }),
      config({ headers: { 'X-Duplicate': 'a', 'x-duplicate': 'b' } }),
      config({
        headers: Object.fromEntries(
          Array.from({ length: 5 }, (_, index) => [
            `x-large-${String(index)}`,
            'x'.repeat(8_192),
          ]),
        ),
      }),
    ])
      expect(httpRequestConfigSchema.safeParse(candidate).success).toBe(false);
    for (const input of [
      { 'un-known': true },
      { '1abc': 'x' },
      { orderId: { nested: true } },
      { orderId: Number.NaN },
    ])
      expect(httpRequestInputSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    ['malformed', 'not-a-url'],
    ['relative', '/relative/path'],
    ['empty', ''],
    ['FTP', 'ftp://example.test/'],
    ['credentials', 'https://user:secret@example.test/'],
    ['fragment', 'https://example.test/path#private'],
    ['credential-like query', 'https://example.test/?api_token=secret'],
    ['UTF-8 byte overflow', `https://example.test/${'é'.repeat(1_014)}`],
  ] as const)('returns an invalid result for a %s URL', (_case, url) => {
    expect(() =>
      httpRequestConfigSchema.safeParse(config({ url })),
    ).not.toThrow();
    expect(httpRequestConfigSchema.safeParse(config({ url })).success).toBe(
      false,
    );
  });

  it('keeps malformed URL admission total at the browser registration boundary', () => {
    expect(() =>
      HTTP_REQUEST_DEFINITION_REGISTRATION.configSchema.safeParse(
        config({ url: 'not-a-url' }),
      ),
    ).not.toThrow();
    expect(
      HTTP_REQUEST_DEFINITION_REGISTRATION.configSchema.safeParse(
        config({ url: 'not-a-url' }),
      ).success,
    ).toBe(false);
  });

  it('rejects every forbidden HTTP field-value control byte', () => {
    const forbidden = [
      ...Array.from({ length: 32 }, (_, codePoint) => codePoint),
      0x7f,
    ].filter((codePoint) => codePoint !== 0x09);
    for (const codePoint of forbidden) {
      const value = `left${String.fromCharCode(codePoint)}right`;
      expect(
        httpRequestConfigSchema.safeParse(
          config({ headers: { 'x-test': value } }),
        ).success,
      ).toBe(false);
    }
    expect(
      httpRequestConfigSchema.safeParse(
        config({ headers: { 'x-test': 'left\tright' } }),
      ).success,
    ).toBe(true);
  });
});
