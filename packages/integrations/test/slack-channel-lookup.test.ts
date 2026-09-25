import { describe, expect, it, vi } from 'vitest';

import {
  createSlackClient,
  SLACK_API_ENDPOINTS,
  type SecureHttpRequest,
  type SecureHttpResponse,
} from '../src/server.js';

const botToken = 'xoxb-123456789-secret';

function lookup(
  status: number,
  payload: string,
  headers: Readonly<Record<string, string>> = {},
) {
  const responseBody = new TextEncoder().encode(payload);
  const requests: SecureHttpRequest[] = [];
  const requestBodies: string[] = [];
  const execute = vi.fn(
    async (request: SecureHttpRequest): Promise<SecureHttpResponse> => {
      requests.push(request);
      requestBodies.push(new TextDecoder().decode(request.body));
      await request.beforeDispatch();
      return {
        status,
        headers,
        body: responseBody,
        bodyEncoding: 'utf8',
        finalUrl: request.url,
        redirectCount: 0,
      };
    },
  );
  const beforeDispatch = vi.fn(() => Promise.resolve());
  const result = createSlackClient({ execute }).lookupChannel({
    botToken,
    channelId: 'C0123ABCD',
    timeoutMillis: 5_000,
    beforeDispatch,
  });
  return { result, requests, requestBodies, responseBody, beforeDispatch };
}

describe('Slack conversations.info channel lookup (ADR 046)', () => {
  it('reads one channel name through the fixed read-only endpoint', async () => {
    const call = lookup(
      200,
      JSON.stringify({
        ok: true,
        channel: {
          id: 'C0123ABCD',
          name: 'ops-alerts',
          is_private: false,
          purpose: { value: 'must not be parsed' },
        },
      }),
    );

    await expect(call.result).resolves.toEqual({
      kind: 'succeeded',
      channelId: 'C0123ABCD',
      name: 'ops-alerts',
    });
    expect(call.requests).toHaveLength(1);
    expect(call.requests[0]).toMatchObject({
      url: SLACK_API_ENDPOINTS.conversationsInfo,
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${botToken}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      timeoutMillis: 5_000,
      maxRedirects: 0,
      maxResponseBytes: 65_536,
      sensitiveValues: [botToken],
    });
    expect(call.requests[0]).not.toHaveProperty('signal');
    expect(call.requestBodies).toEqual(['channel=C0123ABCD']);
    expect(call.beforeDispatch).toHaveBeenCalledOnce();
    expect(call.requests[0]?.body?.every((byte) => byte === 0)).toBe(true);
    expect(call.responseBody.every((byte) => byte === 0)).toBe(true);
  });

  const invalid = { kind: 'invalid_response' } as const;

  it.each<
    readonly [string, number, string, Readonly<Record<string, string>>, unknown]
  >([
    [
      'missing scope',
      200,
      '{"ok":false,"error":"missing_scope"}',
      {},
      { kind: 'rejected', error: 'missing_scope' },
    ],
    [
      'unknown channel',
      200,
      '{"ok":false,"error":"channel_not_found"}',
      {},
      { kind: 'rejected', error: 'channel_not_found' },
    ],
    ['a failure without a reason', 200, '{"ok":false}', {}, invalid],
    ['success without a channel', 200, '{"ok":true}', {}, invalid],
    [
      'another channel',
      200,
      '{"ok":true,"channel":{"id":"C9999","name":"elsewhere"}}',
      {},
      invalid,
    ],
    [
      'an unbounded name',
      200,
      JSON.stringify({
        ok: true,
        channel: { id: 'C0123ABCD', name: 'x'.repeat(81) },
      }),
      {},
      invalid,
    ],
    [
      'a name with markup',
      200,
      '{"ok":true,"channel":{"id":"C0123ABCD","name":"<b>ops</b>"}}',
      {},
      invalid,
    ],
    ['malformed JSON', 200, '{', {}, invalid],
    [
      'throttling',
      429,
      '{}',
      { 'retry-after': '7' },
      { kind: 'rate_limited', retryAfterMillis: 7_000 },
    ],
    ['a provider outage', 503, '{}', {}, { kind: 'http_failure', status: 503 }],
  ])(
    'classifies %s without keeping provider bytes',
    async (_label, status, payload, headers, expected) => {
      const call = lookup(status, payload, headers);

      await expect(call.result).resolves.toEqual(expected);
      expect(call.responseBody.every((byte) => byte === 0)).toBe(true);
    },
  );

  it('accepts non-Latin channel names and forwards a caller signal', async () => {
    const controller = new AbortController();
    const execute = vi.fn(
      (request: SecureHttpRequest): Promise<SecureHttpResponse> =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: new TextEncoder().encode(
            '{"ok":true,"channel":{"id":"G0123","name":"équipe_ops-2"}}',
          ),
          bodyEncoding: 'utf8',
          finalUrl: request.url,
          redirectCount: 0,
        }),
    );

    await expect(
      createSlackClient({ execute }).lookupChannel({
        botToken,
        channelId: 'G0123',
        timeoutMillis: 5_000,
        signal: controller.signal,
        beforeDispatch: () => Promise.resolve(),
      }),
    ).resolves.toEqual({
      kind: 'succeeded',
      channelId: 'G0123',
      name: 'équipe_ops-2',
    });
    expect(execute.mock.calls[0]?.[0].signal).toBe(controller.signal);
  });
});
