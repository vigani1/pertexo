import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type FormData from 'form-data';
import { HTTP_REQUEST_LIMITS } from '../validation.js';
import { FileInputFailure } from '@pertexo/node-sdk/server';

/** The encoder receives only bounded Buffers; its legacy stream owns MIME framing. */
export async function collectMultipart(
  form: FormData,
  length: number,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  if (length > HTTP_REQUEST_LIMITS.maxRequestBodyBytes)
    throw new FileInputFailure({ reason: 'multipart_size' });
  const body = Buffer.alloc(length);
  let offset = 0;
  const sink = new Writable({
    write(chunk: unknown, _encoding, done) {
      if (
        !(chunk instanceof Uint8Array) ||
        chunk.byteLength > length - offset
      ) {
        done(new FileInputFailure({ reason: 'multipart_encoding' }));
        return;
      }
      body.set(chunk, offset);
      offset += chunk.byteLength;
      done();
    },
  });
  const fail = (error: Error) => {
    sink.destroy(error);
  };
  form.once('error', fail);
  try {
    // CombinedStream is not a modern Readable: pipeline() cannot observe its close.
    const completion = finished(sink, { signal, cleanup: true });
    try {
      form.pipe(sink);
    } catch {
      sink.destroy(new FileInputFailure({ reason: 'multipart_encoding' }));
    }
    await completion;
    signal.throwIfAborted();
    if (offset !== length)
      throw new FileInputFailure({ reason: 'multipart_encoding' });
    return body;
  } catch {
    body.fill(0);
    signal.throwIfAborted();
    throw new FileInputFailure({ reason: 'multipart_encoding' });
  } finally {
    form.destroy();
    sink.destroy();
    form.removeListener('error', fail);
  }
}
