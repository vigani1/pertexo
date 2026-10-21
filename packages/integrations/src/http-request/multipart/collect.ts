import { PassThrough } from 'node:stream';
import type FormData from 'form-data';
import {
  FileInputFailure,
  type NodeArtifactRuntime,
} from '@pertexo/node-sdk/server';
import { HTTP_REQUEST_LIMITS } from '../validation.js';

/** CombinedStream needs an explicit bridge: it does not expose modern close semantics. */
export async function collectMultipart(
  form: FormData,
  length: number,
  signal: AbortSignal,
  spool: NonNullable<NodeArtifactRuntime['spool']>,
) {
  signal.throwIfAborted();
  if (length > HTTP_REQUEST_LIMITS.maxRequestBodyBytes)
    throw new FileInputFailure({ reason: 'multipart_size' });
  const bridge = new PassThrough({ highWaterMark: 65536 });
  bridge.on('error', () => undefined);
  const fail = () => {
    bridge.destroy(new FileInputFailure({ reason: 'multipart_encoding' }));
  };
  form.once('error', fail);
  const cancelSource = (reason: Error): void => {
    form.destroy();
    bridge.destroy(reason);
  };
  async function* chunks() {
    let count = 0;
    form.pipe(bridge);
    for await (const chunk of bridge) {
      if (!(chunk instanceof Uint8Array) || count + chunk.byteLength > length)
        throw new FileInputFailure({ reason: 'multipart_encoding' });
      count += chunk.byteLength;
      yield chunk;
    }
    if (count !== length)
      throw new FileInputFailure({ reason: 'multipart_encoding' });
  }
  try {
    return await spool({
      body: chunks(),
      maxBytes: length,
      signal,
      cancelSource,
    });
  } finally {
    form.destroy();
    bridge.destroy();
    form.removeListener('error', fail);
  }
}
