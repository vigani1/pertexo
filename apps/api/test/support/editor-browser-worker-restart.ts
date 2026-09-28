import type { EventEmitter } from 'node:events';

type RestartChannel = Pick<EventEmitter, 'on' | 'off'> &
  Readonly<{
    connected: boolean;
    send(message: object, callback: (error: Error | null) => void): boolean;
  }>;

/** One correlated fixture command; cancellation never claims runtimes rolled back. */
export function restartEditorBrowserWorker(
  child: RestartChannel,
  requestId: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('message', message);
      child.off('error', failed);
      child.off('exit', exited);
      signal.removeEventListener('abort', aborted);
      if (error === undefined) resolve();
      else reject(error);
    };
    const message = (value: unknown) => {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('phase' in value) ||
        value.phase !== 'worker-runtime-restarted' ||
        !('requestId' in value) ||
        value.requestId !== requestId
      )
        return;
      finish(
        'success' in value && value.success === true
          ? undefined
          : new Error('Owned worker restart failed'),
      );
    };
    const failed = () => {
      finish(new Error('Owned worker restart channel failed'));
    };
    const exited = () => {
      finish(new Error('Owned worker exited during restart'));
    };
    const aborted = () => {
      finish(new Error('Owned worker restart observation disposed'));
    };
    const timer = setTimeout(() => {
      finish(new Error('Owned worker restart acknowledgement timed out'));
    }, 15_000);
    child.on('message', message);
    child.on('error', failed);
    child.on('exit', exited);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) {
      aborted();
      return;
    }
    if (!child.connected) {
      failed();
      return;
    }
    try {
      child.send({ phase: 'restart-worker-runtime', requestId }, (error) => {
        if (error !== null) failed();
      });
    } catch {
      failed();
    }
  });
}
