import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { withRequestOperationSignal } from '../../../src/platform/http/request-operation-signal.js';

class RequestStream extends EventEmitter {
  public complete = false;
  public destroyed = false;
  public readonly socket = new RequestSocket();
}

class RequestSocket extends EventEmitter {
  public destroyed = false;
}

describe('request operation signal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aborts work when the client socket closes after request consumption', async () => {
    const raw = new RequestStream();
    const operation = withRequestOperationSignal({ raw }, async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      });
      return signal.aborted;
    });

    raw.socket.emit('close');

    await expect(operation).resolves.toBe(true);
    expect(raw.listenerCount('aborted')).toBe(0);
    expect(raw.socket.listenerCount('close')).toBe(0);
  });

  it('aborts work when the request emits aborted', async () => {
    const raw = new RequestStream();
    const operation = withRequestOperationSignal({ raw }, async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      });
      return signal.reason as unknown;
    });

    raw.emit('aborted');

    await expect(operation).resolves.toMatchObject({ name: 'AbortError' });
    expect(raw.listenerCount('aborted')).toBe(0);
    expect(raw.socket.listenerCount('close')).toBe(0);
  });

  it('removes both listeners after successful and rejected work', async () => {
    const successful = new RequestStream();
    await expect(
      withRequestOperationSignal({ raw: successful }, () =>
        Promise.resolve('complete'),
      ),
    ).resolves.toBe('complete');
    expect(successful.listenerCount('aborted')).toBe(0);
    expect(successful.socket.listenerCount('close')).toBe(0);

    const rejected = new RequestStream();
    const failure = new Error('work failed');
    await expect(
      withRequestOperationSignal({ raw: rejected }, () =>
        Promise.reject(failure),
      ),
    ).rejects.toBe(failure);
    expect(rejected.listenerCount('aborted')).toBe(0);
    expect(rejected.socket.listenerCount('close')).toBe(0);
  });

  it('removes both listeners after work throws synchronously', async () => {
    const raw = new RequestStream();
    const failure = new Error('synchronous work failure');

    await expect(
      withRequestOperationSignal({ raw }, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(raw.listenerCount('aborted')).toBe(0);
    expect(raw.socket.listenerCount('close')).toBe(0);
  });

  it('provides a controlled timeout signal without waiting for the real deadline', async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeout.signal);
    const raw = new RequestStream();
    const operation = withRequestOperationSignal({ raw }, async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      });
      return signal.reason as unknown;
    });

    timeout.abort(new DOMException('Timed out', 'TimeoutError'));

    await expect(operation).resolves.toMatchObject({ name: 'TimeoutError' });
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    expect(raw.listenerCount('aborted')).toBe(0);
    expect(raw.socket.listenerCount('close')).toBe(0);
  });

  it('starts already aborted for a destroyed client socket', async () => {
    const raw = new RequestStream();
    raw.socket.destroyed = true;

    await expect(
      withRequestOperationSignal({ raw }, (signal) =>
        Promise.resolve(signal.aborted),
      ),
    ).resolves.toBe(true);
  });

  it('keeps work active after a request body is fully consumed on a healthy socket', async () => {
    const raw = new RequestStream();
    raw.complete = true;
    raw.destroyed = true;

    await expect(
      withRequestOperationSignal({ raw }, (signal) =>
        Promise.resolve(signal.aborted),
      ),
    ).resolves.toBe(false);
  });
});
