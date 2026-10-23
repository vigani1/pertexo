import { inlineBytes } from '../../support/artifact-runtime.js';

import { describe, expect, it, vi } from 'vitest';

import {
  createSlackClient,
  type SecureHttpRequest,
  type SecureHttpResponse,
} from '../../../src/server.js';

describe('slack.send_message@1', () => {
  it.each(['send-message', 'auth-test'] as const)(
    'rejects invalid UTF-8 for %s through the shared response envelope parser',
    async (operation) => {
      const body = Uint8Array.of(0xff);
      const client = createSlackClient({
        execute: (request) =>
          Promise.resolve({
            status: 200,
            headers: {},
            body,
            bodyEncoding: 'utf8',
            finalUrl: request.url,
            redirectCount: 0,
          }),
      });
      const result =
        operation === 'send-message'
          ? client.sendMessage({
              botToken: 'xoxb-123456789-secret',
              channelId: 'C123ABC',
              text: 'deployment complete',
              timeoutMillis: 30_000,
              signal: new AbortController().signal,
              beforeDispatch: () => Promise.resolve(),
            })
          : client.authTest({
              botToken: 'xoxb-123456789-secret',
              timeoutMillis: 30_000,
              beforeDispatch: () => Promise.resolve(),
            });

      await expect(result).resolves.toEqual({ kind: 'invalid_response' });
      expect(body.every((byte) => byte === 0)).toBe(true);
    },
  );
  it('uses only the fixed endpoint, one bounded request, no redirects, and inaccessible unfurls', async () => {
    let requestBody: Uint8Array | undefined;
    const execute = vi.fn(
      async (request: SecureHttpRequest): Promise<SecureHttpResponse> => {
        const bytes = inlineBytes(request.body);
        requestBody = bytes === undefined ? undefined : new Uint8Array(bytes);
        expect(request).toMatchObject({
          url: 'https://slack.com/api/chat.postMessage',
          method: 'POST',
          maxRedirects: 0,
          maxResponseBytes: 65_536,
          timeoutMillis: 30_000,
          sensitiveValues: ['xoxb-123456789-secret'],
        });
        await request.beforeDispatch();
        return {
          status: 200,
          headers: {},
          body: new TextEncoder().encode(
            JSON.stringify({
              ok: true,
              channel: 'C123ABC',
              ts: '1724412345.000100',
              token: 'must-not-parse',
            }),
          ),
          bodyEncoding: 'utf8' as const,
          finalUrl: 'https://slack.com',
          redirectCount: 0,
        };
      },
    );
    const result = await createSlackClient({ execute }).sendMessage({
      botToken: 'xoxb-123456789-secret',
      channelId: 'C123ABC',
      text: 'deployment complete',
      timeoutMillis: 30_000,
      signal: new AbortController().signal,
      beforeDispatch: () => Promise.resolve(),
    });
    expect(result).toEqual({
      kind: 'succeeded',
      channelId: 'C123ABC',
      messageTs: '1724412345.000100',
    });
    expect(JSON.parse(new TextDecoder().decode(requestBody))).toEqual({
      channel: 'C123ABC',
      text: 'deployment complete',
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(execute).toHaveBeenCalledOnce();
  });
  it('bounds Retry-After and performs fixed auth.test without a caller URL', async () => {
    const execute = vi.fn(
      (request: SecureHttpRequest): Promise<SecureHttpResponse> =>
        Promise.resolve({
          status: 429,
          headers: { 'retry-after': '999999999' },
          body: new TextEncoder().encode('{}'),
          bodyEncoding: 'utf8' as const,
          finalUrl: request.url,
          redirectCount: 0,
        }),
    );
    await expect(
      createSlackClient({ execute }).authTest({
        botToken: 'xoxb-123456789-secret',
        timeoutMillis: 15_000,
        beforeDispatch: () => Promise.resolve(),
      }),
    ).resolves.toEqual({ kind: 'rate_limited', retryAfterMillis: 300_000 });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://slack.com/api/auth.test',
        maxRedirects: 0,
      }),
    );
  });
  it.each([
    [429, {}, '{}', { kind: 'rate_limited', retryAfterMillis: 1_000 }],
    [
      429,
      { 'retry-after': 'invalid' },
      '{}',
      { kind: 'rate_limited', retryAfterMillis: 1_000 },
    ],
    [
      429,
      { 'retry-after': '0' },
      '{}',
      { kind: 'rate_limited', retryAfterMillis: 1_000 },
    ],
    [500, {}, '{}', { kind: 'http_failure', status: 500 }],
    [200, {}, '{', { kind: 'invalid_response' }],
    [200, {}, '{"ok":"yes"}', { kind: 'invalid_response' }],
    [200, {}, '{"ok":false}', { kind: 'invalid_response' }],
    [
      200,
      {},
      '{"ok":false,"error":"invalid_auth"}',
      { kind: 'rejected', error: 'invalid_auth' },
    ],
    [200, {}, '{"ok":true}', { kind: 'invalid_response' }],
  ] as const)(
    'classifies send-message HTTP %s response %s without retaining provider bytes',
    async (status, headers, payload, expected) => {
      const body = new TextEncoder().encode(payload);
      const client = createSlackClient({
        execute: (request) => {
          expect(request.signal).toBeInstanceOf(AbortSignal);
          return Promise.resolve({
            status,
            headers,
            body,
            bodyEncoding: 'utf8',
            finalUrl: request.url,
            redirectCount: 0,
          });
        },
      });

      await expect(
        client.sendMessage({
          botToken: 'xoxb-123456789-secret',
          channelId: 'C123ABC',
          text: 'deployment complete',
          timeoutMillis: 30_000,
          signal: new AbortController().signal,
          beforeDispatch: () => Promise.resolve(),
        }),
      ).resolves.toEqual(expected);
      expect(body.every((byte) => byte === 0)).toBe(true);
    },
  );
  it.each([
    [500, '{}', { kind: 'http_failure', status: 500 }],
    [200, '{', { kind: 'invalid_response' }],
    [200, '{"ok":"yes"}', { kind: 'invalid_response' }],
    [200, '{"ok":true}', { kind: 'succeeded' }],
    [200, '{"ok":false}', { kind: 'invalid_response' }],
    [
      200,
      '{"ok":false,"error":"invalid_auth"}',
      { kind: 'rejected', error: 'invalid_auth' },
    ],
  ] as const)(
    'classifies auth-test HTTP %s response with a caller signal',
    async (status, payload, expected) => {
      const body = new TextEncoder().encode(payload);
      const client = createSlackClient({
        execute: (request) => {
          expect(request.signal).toBeInstanceOf(AbortSignal);
          return Promise.resolve({
            status,
            headers: {},
            body,
            bodyEncoding: 'utf8',
            finalUrl: request.url,
            redirectCount: 0,
          });
        },
      });

      await expect(
        client.authTest({
          botToken: 'xoxb-123456789-secret',
          timeoutMillis: 30_000,
          signal: new AbortController().signal,
          beforeDispatch: () => Promise.resolve(),
        }),
      ).resolves.toEqual(expected);
      expect(body.every((byte) => byte === 0)).toBe(true);
    },
  );
});
