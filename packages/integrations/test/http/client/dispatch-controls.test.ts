import { describe, expect, it, vi } from 'vitest';

import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpClient,
  type SecureHttpTransportResponse,
} from '../../../src/server.js';
import {
  encoder,
  decoder,
  FakeResolver,
  FakeTransport,
  request,
  expectSecureFailure,
} from '../../support/http-client.js';
describe('secure HTTP client', () => {
  it('maps a transport rejection as cancellation when abort wins before catch resumes', async () => {
    const controller = new AbortController();
    let dispatchStarted: (() => void) | undefined;
    let rejectTransport: ((error: Error) => void) | undefined;
    const started = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    const transport = new FakeTransport(
      () =>
        new Promise((_resolve, reject) => {
          rejectTransport = reject;
          dispatchStarted?.();
        }),
    );
    const execution = new SecureHttpClient(
      new FakeResolver({
        'api.example.test': [{ address: '8.8.8.8', family: 4 }],
      }),
      transport,
    ).execute(request({ signal: controller.signal }));
    await started;

    rejectTransport?.(new Error('transport failed during cancellation'));
    queueMicrotask(() => {
      controller.abort(new Error('caller-secret'));
    });

    await expectSecureFailure(execution, {
      code: SECURE_HTTP_ERROR_CODE.canceled,
      classification: 'ambiguous',
      possiblyDispatched: true,
    });
  });
  it('ignores empty response chunks without emitting spurious content', async () => {
    const empty = new Uint8Array();
    const close = vi.fn();
    const response: SecureHttpTransportResponse = {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      close,
      body: {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield empty;
          yield encoder.encode('sec');
          yield new Uint8Array();
          yield encoder.encode('ret');
        },
      },
    };
    const result = await new SecureHttpClient(
      new FakeResolver({
        'api.example.test': [{ address: '8.8.8.8', family: 4 }],
      }),
      new FakeTransport(() => Promise.resolve(response)),
    ).execute(request({ sensitiveValues: ['secret'] }));

    expect(decoder.decode(result.body)).toBe('[Redacted]');
    expect(empty).toHaveLength(0);
    expect(close).toHaveBeenCalledOnce();
  });
  it('does not report definite pre-dispatch cancellation while the marker can still commit', async () => {
    const controller = new AbortController();
    let releaseMarker: (() => void) | undefined;
    let committed = false;
    const markerStarted = vi.fn();
    const markerGate = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    const dispatch = vi.fn();
    const execution = new SecureHttpClient(
      new FakeResolver({
        'api.example.test': [{ address: '8.8.8.8', family: 4 }],
      }),
      { dispatch },
    ).execute(
      request({
        signal: controller.signal,
        beforeDispatch: async () => {
          markerStarted();
          await markerGate;
          committed = true;
        },
      }),
    );
    await vi.waitFor(() => {
      expect(markerStarted).toHaveBeenCalledOnce();
    });
    let settled = false;
    void execution
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseMarker?.();
    await expectSecureFailure(execution, {
      code: SECURE_HTTP_ERROR_CODE.canceled,
      classification: 'ambiguous',
      possiblyDispatched: true,
    });
    expect(committed).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
