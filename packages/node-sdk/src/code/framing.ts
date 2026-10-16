import { Buffer } from 'node:buffer';
import type { Readable, Writable } from 'node:stream';

/** One bounded UTF-8 JSON frame; callers own connection/process lifetime. */
export function readCodeFrame(
  stream: Readable,
  maximum: number,
  signal: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
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
      bytes += chunk.length;
      if (bytes > maximum) {
        error(new Error('Code protocol exceeds its byte bound'));
        return;
      }
      const end = chunk.indexOf(10);
      if (end === -1) {
        chunks.push(chunk);
        return;
      }
      if (end !== chunk.length - 1) {
        error(new Error('Code protocol has trailing data'));
        return;
      }
      chunks.push(chunk.subarray(0, end));
      cleanup();
      stream.pause();
      try {
        resolve(
          JSON.parse(
            new TextDecoder('utf8', { fatal: true }).decode(
              Buffer.concat(chunks),
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
