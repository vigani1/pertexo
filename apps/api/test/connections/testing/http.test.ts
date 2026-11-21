import { expect, it, vi } from 'vitest';
import { testHttpConnection } from '../../../src/connections/testing/http.js';
import type { ConnectionHttpClient } from '../../../src/connections/ports.js';
import { connectionId } from '../use-cases/test-connection-fixture.js';

it.each([
  {
    status: 204,
    json: undefined,
    body: '',
    expected: { ok: true, httpStatus: 204 },
  },
  {
    status: 201,
    json: true,
    body: '{"reply/items":[{"~accepted":true}]}',
    expected: { ok: true, httpStatus: 201 },
  },
  {
    status: 200,
    json: true,
    body: '{"reply/items":[{"~accepted":false}]}',
    expected: {
      ok: false,
      httpStatus: 200,
      errorCode: 'connection.provider_rejected',
    },
  },
  {
    status: 200,
    json: true,
    body: '{"reply/items":[]}',
    expected: {
      ok: false,
      httpStatus: null,
      errorCode: 'connection.provider_invalid_response',
    },
  },
  {
    status: 200,
    json: true,
    body: '{',
    expected: {
      ok: false,
      httpStatus: null,
      errorCode: 'connection.provider_invalid_response',
    },
  },
  {
    status: 503,
    json: true,
    body: '',
    expected: {
      ok: false,
      httpStatus: 503,
      errorCode: 'connection.provider_unavailable',
    },
  },
])(
  'checks HTTP $status with response $body',
  async ({ status, body, json, expected }) => {
    const url = 'https://provider.example.test/health';
    const bytes = new TextEncoder().encode(body);
    const execute = vi.fn<ConnectionHttpClient['execute']>().mockResolvedValue({
      status,
      headers: {},
      body: bytes,
      bodyEncoding: 'utf8',
      finalUrl: url,
      redirectCount: 0,
    });
    const outcome = await testHttpConnection(
      { execute },
      {
        request: { providerKey: 'slack' },
        credential: { type: 'slack_bot_token', botToken: 'fixture-token' },
        auth: { kind: 'named_header', name: 'x-api-key', field: 'botToken' },
        recipe: {
          kind: 'http',
          method: 'GET',
          target: url,
          success: {
            status: '2xx',
            ...(json === undefined
              ? {}
              : {
                  json: {
                    equals: {
                      pointer: '/reply~1items/0/~0accepted',
                      value: true,
                    },
                  },
                }),
          },
        },
        command: { connectionId, idempotencyKey: 'fixture-test' },
        timeoutMillis: 1000,
        maxRedirects: 3,
        maxResponseBytes: 1024,
        signal: new AbortController().signal,
        beforeDispatch: () => Promise.resolve(),
      },
    );
    expect(outcome).toMatchObject(expected);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        url,
        method: 'GET',
        headers: { 'x-api-key': 'fixture-token' },
        maxRedirects: 0,
        sensitiveValues: ['fixture-token'],
      }),
    );
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  },
);
