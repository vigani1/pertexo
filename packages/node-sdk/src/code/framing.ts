import { Buffer } from 'node:buffer';
import type { Readable, Writable } from 'node:stream';

/** One bounded UTF-8 JSON frame; callers own connection/process lifetime. */
export function readCodeFrame(
  stream: Readable,
  maximum: number,
  signal: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // A byte ceiling must also bound fragmented-message bookkeeping. Never
    // retain one Buffer/object per attacker-controlled chunk.
    const body = Buffer.allocUnsafe(maximum);
    let bytes = 0;
    const cleanup = () => {
      stream.off('data', data);
      stream.off('error', error);
      stream.off('end', ended);
      signal.removeEventListener('abort', aborted);
    };
    const error = (reason: Error) => {
      cleanup();
      reject(reason);
    };
    const ended = () => {
      error(new Error('Code protocol ended before its result'));
    };
    const aborted = () => {
      error(new Error('Code protocol aborted', { cause: signal.reason }));
    };
    const data = (chunk: Buffer) => {
      const end = chunk.indexOf(10);
      const previous = bytes;
      bytes += end === -1 ? chunk.length : end + 1;
      if (bytes > maximum) {
        error(new Error('Code protocol exceeds its byte bound'));
        return;
      }
      if (end === -1) {
        chunk.copy(body, previous);
        return;
      }
      chunk.copy(body, previous, 0, end);
      cleanup();
      stream.pause();
      // A peer may send its next frame before this one is read (a runner's
      // queued then ready greeting); it stays on the stream for the next read.
      if (end < chunk.length - 1) stream.unshift(chunk.subarray(end + 1));
      try {
        resolve(
          JSON.parse(
            new TextDecoder('utf8', { fatal: true }).decode(
              body.subarray(0, bytes - 1),
            ),
          ) as unknown,
        );
      } catch {
        reject(new Error('Code protocol is not JSON'));
      }
    };
    if (signal.aborted) {
      aborted();
      return;
    }
    signal.addEventListener('abort', aborted, { once: true });
    stream.on('data', data);
    stream.once('error', error);
    stream.once('end', ended);
    stream.resume();
  });
}
export function writeCodeFrame(
  stream: Writable,
  value: unknown,
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(JSON.stringify(value) + '\n', (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
