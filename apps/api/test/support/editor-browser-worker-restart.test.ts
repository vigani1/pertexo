import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { restartEditorBrowserWorker } from './editor-browser-worker-restart.js';

function channel() {
  return Object.assign(new EventEmitter(), {
    connected: true,
    send: vi.fn((_message: object, callback: (error: Error | null) => void) => {
      callback(null);
      return true;
    }),
  });
}
describe('correlated owned worker restart observation', () => {
  it('ignores other replies and removes observers after its exact acknowledgement', async () => {
    const child = channel();
    const controller = new AbortController();
    const observed = restartEditorBrowserWorker(
      child,
      'expected',
      controller.signal,
    );
    let completed = false;
    void observed.then(() => {
      completed = true;
    });
    child.emit('message', {
      phase: 'worker-runtime-restarted',
      requestId: 'other',
      success: true,
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(child.send).toHaveBeenCalledExactlyOnceWith(
      { phase: 'restart-worker-runtime', requestId: 'expected' },
      expect.any(Function),
    );
    child.emit('message', {
      phase: 'worker-runtime-restarted',
      requestId: 'expected',
      success: true,
    });
    await observed;
    expect(child.eventNames()).toEqual([]);
  });
  it.each(['abort', 'exit', 'failure', 'error'] as const)(
    'rejects %s and ignores late success',
    async (failure) => {
      const child = channel();
      const controller = new AbortController();
      const observed = restartEditorBrowserWorker(
        child,
        'expected',
        controller.signal,
      );
      const rejected = expect(observed).rejects.toThrow(/Owned worker/u);
      if (failure === 'abort') controller.abort();
      else if (failure === 'exit') child.emit('exit', 0);
      else if (failure === 'error')
        child.emit('error', new Error('private channel detail'));
      else
        child.emit('message', {
          phase: 'worker-runtime-restarted',
          requestId: 'expected',
          success: false,
        });
      child.emit('message', {
        phase: 'worker-runtime-restarted',
        requestId: 'expected',
        success: true,
      });
      await rejected;
      expect(child.eventNames()).toEqual([]);
    },
  );
  it('never dispatches after disposal', async () => {
    const child = channel();
    const controller = new AbortController();
    controller.abort();
    await expect(
      restartEditorBrowserWorker(child, 'expected', controller.signal),
    ).rejects.toThrow('disposed');
    expect(child.send).not.toHaveBeenCalled();
    expect(child.eventNames()).toEqual([]);
  });
  it('rejects failed delivery without a second command', async () => {
    const child = channel();
    child.send.mockImplementationOnce((_message, callback) => {
      callback(new Error('private IPC detail'));
      return false;
    });
    await expect(
      restartEditorBrowserWorker(
        child,
        'expected',
        new AbortController().signal,
      ),
    ).rejects.toThrow('channel failed');
    expect(child.send).toHaveBeenCalledOnce();
    expect(child.eventNames()).toEqual([]);
  });
  it('times out without retry or leaked listeners', async () => {
    vi.useFakeTimers();
    try {
      const child = channel();
      const observed = restartEditorBrowserWorker(
        child,
        'expected',
        new AbortController().signal,
      );
      const rejected = expect(observed).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
      expect(child.send).toHaveBeenCalledOnce();
      expect(child.eventNames()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
