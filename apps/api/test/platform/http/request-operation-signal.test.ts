import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { withRequestOperationSignal } from '../../../src/platform/http/request-operation-signal.js';

class RequestStream extends EventEmitter {
  public destroyed = false;
  public readonly socket = new RequestSocket();
}

class RequestSocket extends EventEmitter {
  public destroyed = false;
}

describe('request operation signal', () => {
  it('aborts work when the client socket closes after request consumption', async () => {
    const raw = new RequestStream();
    const operation = withRequestOperationSignal({ raw }, async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return signal.reason;
    });

    raw.socket.emit('close');

    await expect(operation).resolves.toMatchObject({ name: 'AbortError' });
    expect(raw.listenerCount('aborted')).toBe(0);
    expect(raw.socket.listenerCount('close')).toBe(0);
  });

  it('starts already aborted for a destroyed client socket', async () => {
    const raw = new RequestStream();
    raw.socket.destroyed = true;

    await expect(
      withRequestOperationSignal({ raw }, async (signal) => signal.aborted),
    ).resolves.toBe(true);
  });
});
