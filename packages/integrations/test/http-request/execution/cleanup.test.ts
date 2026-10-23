import { describe, expect, it, vi } from 'vitest';

import {
  createHttpRequestExecutorRegistration,
  HttpRequestExecutorError,
} from '../../../src/server.js';
import { runtime, invocation, response } from '../../support/http-execution.js';
describe('http.request@1 server executor', () => {
  it('preserves a streamed body failure with hostile iterator cleanup without double-closing ownership', async () => {
    const state = runtime();
    const readError = new Error('response body failed');
    const returnError = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('cleanup-prototype-trap');
        },
      },
    );
    const providerBody = new Uint8Array(70_000).fill(7);
    const closeBody = vi.fn().mockRejectedValue(returnError);
    let reads = 0;
    const registration = createHttpRequestExecutorRegistration({
      httpClient: {
        executeStreaming: async (request, consume) => {
          await request.beforeDispatch();
          const body = await consume({
            ...response(new Uint8Array()),
            body: {
              [Symbol.asyncIterator]: () => ({
                next: () => {
                  reads += 1;
                  return reads === 1
                    ? Promise.resolve({
                        done: false as const,
                        value: providerBody,
                      })
                    : Promise.reject<IteratorResult<Uint8Array>>(readError);
                },
                return: closeBody,
              }),
            },
            signal: request.signal ?? new AbortController().signal,
          });
          return { ...response(new Uint8Array()), body };
        },
      },
    });

    const failure = await registration
      .execute(invocation(state.value))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HttpRequestExecutorError);
    expect(failure).toMatchObject({
      decision: { kind: 'outcome_unknown', errorKind: 'provider' },
      possiblyDispatched: true,
    });
    expect((failure as HttpRequestExecutorError).cause).toBeInstanceOf(
      AggregateError,
    );
    const cleanupErrors = (
      (failure as HttpRequestExecutorError).cause as AggregateError
    ).errors;
    expect(cleanupErrors).toHaveLength(2);
    expect(cleanupErrors[0]).toBe(readError);
    expect(cleanupErrors[1]).toBe(returnError);
    expect(closeBody).toHaveBeenCalledOnce();
    expect(providerBody.every((byte) => byte === 0)).toBe(true);
  });
  it('closes an unclaimed response body when artifact writing rejects before iteration', async () => {
    const writeError = new Error('artifact write rejected before iteration');
    const write = vi.fn(() => Promise.reject(writeError));
    const providerBody = new Uint8Array(70_000).fill(7);
    const closeBody = vi.fn().mockResolvedValue({
      done: true as const,
      value: undefined,
    });
    const state = runtime({ artifacts: { write } });
    const registration = createHttpRequestExecutorRegistration({
      httpClient: {
        executeStreaming: async (request, consume) => {
          await request.beforeDispatch();
          const body = await consume({
            ...response(new Uint8Array()),
            body: {
              [Symbol.asyncIterator]: () => ({
                next: () =>
                  Promise.resolve({
                    done: false as const,
                    value: providerBody,
                  }),
                return: closeBody,
              }),
            },
            signal: request.signal ?? new AbortController().signal,
          });
          return { ...response(new Uint8Array()), body };
        },
      },
    });

    const failure = await registration
      .execute(invocation(state.value))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HttpRequestExecutorError);
    expect((failure as HttpRequestExecutorError).cause).toBe(writeError);
    expect(write).toHaveBeenCalledOnce();
    expect(closeBody).toHaveBeenCalledOnce();
    expect(providerBody.every((byte) => byte === 0)).toBe(true);
  });
  it('closes an owned response body when artifact writing rejects after one chunk', async () => {
    const writeError = new Error('artifact write rejected after iteration');
    const state = runtime();
    const providerBody = new Uint8Array(70_000).fill(7);
    const closeBody = vi.fn().mockResolvedValue({
      done: true as const,
      value: undefined,
    });
    state.write.mockImplementation(async (input) => {
      const iterator = input.body[Symbol.asyncIterator]();
      await iterator.next();
      throw writeError;
    });
    const registration = createHttpRequestExecutorRegistration({
      httpClient: {
        executeStreaming: async (request, consume) => {
          await request.beforeDispatch();
          const body = await consume({
            ...response(new Uint8Array()),
            body: {
              [Symbol.asyncIterator]: () => ({
                next: () =>
                  Promise.resolve({
                    done: false as const,
                    value: providerBody,
                  }),
                return: closeBody,
              }),
            },
            signal: request.signal ?? new AbortController().signal,
          });
          return { ...response(new Uint8Array()), body };
        },
      },
    });

    const failure = await registration
      .execute(invocation(state.value))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HttpRequestExecutorError);
    expect((failure as HttpRequestExecutorError).cause).toBe(writeError);
    expect(state.write).toHaveBeenCalledOnce();
    expect(closeBody).toHaveBeenCalledOnce();
    expect(providerBody.every((byte) => byte === 0)).toBe(true);
  });
  it.each([
    ['Error', new Error('response body cleanup failed')],
    ['non-Error', 'response body cleanup rejected'],
    [
      'hostile object',
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error('cleanup-prototype-trap');
          },
        },
      ),
    ],
  ])(
    'preserves a sole %s streamed-body cleanup failure',
    async (_label, reason) => {
      const state = runtime();
      const providerBody = new Uint8Array(70_000).fill(7);
      const closeBody = vi.fn().mockRejectedValue(reason);
      let reads = 0;
      const registration = createHttpRequestExecutorRegistration({
        httpClient: {
          executeStreaming: async (request, consume) => {
            await request.beforeDispatch();
            const body = await consume({
              ...response(new Uint8Array()),
              body: {
                [Symbol.asyncIterator]: () => ({
                  next: () => {
                    reads += 1;
                    return Promise.resolve(
                      reads === 1
                        ? { done: false as const, value: providerBody }
                        : { done: true as const, value: undefined },
                    );
                  },
                  return: closeBody,
                }),
              },
              signal: request.signal ?? new AbortController().signal,
            });
            return { ...response(new Uint8Array()), body };
          },
        },
      });

      const failure = (await registration
        .execute(invocation(state.value))
        .catch((error: unknown) => error)) as HttpRequestExecutorError;

      expect(failure).toBeInstanceOf(HttpRequestExecutorError);
      if (_label === 'Error') expect(failure.cause).toBe(reason);
      else {
        expect(failure.cause).toMatchObject({
          message: 'HTTP response body cleanup failed',
        });
        expect((failure.cause as Error).cause).toBe(reason);
      }
      expect(closeBody).toHaveBeenCalledOnce();
      expect(providerBody.every((byte) => byte === 0)).toBe(true);
    },
  );
});
