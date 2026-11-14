import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { vi } from 'vitest';
import type {
  NodeArtifactReference,
  NodeArtifactRuntime,
  NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';

export function files() {
  const data = new Map<string, Buffer>();
  const add = (bytes: Buffer, mediaType = 'application/json') => {
    const reference = {
      artifactId: randomUUID(),
      byteLength: bytes.length,
      mediaType,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    data.set(reference.artifactId, Buffer.from(bytes));
    return { kind: 'artifact' as const, ...reference };
  };
  const get = (id: string) => {
    const bytes = data.get(id);
    if (bytes === undefined) throw new Error('Missing fixture file');
    return bytes;
  };
  const find = (reference: NodeArtifactReference) => {
    const bytes = get(reference.artifactId);
    if (
      bytes.length !== reference.byteLength ||
      createHash('sha256').update(bytes).digest('hex') !== reference.sha256
    )
      throw new Error('Reference not authorized');
    return bytes;
  };
  const release = vi.fn(() => Promise.resolve());
  const write = vi.fn<NodeArtifactRuntime['write']>(async (input) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of input.body) {
      input.signal.throwIfAborted();
      size += chunk.byteLength;
      if (size > input.maxBytes) throw new Error('Too large');
      chunks.push(Buffer.from(chunk));
    }
    return add(Buffer.concat(chunks), input.mediaType);
  });
  const artifacts: NodeArtifactRuntime = {
    write,
    read: async ({ reference, maxBytes }) => {
      const bytes = find(reference);
      if (bytes.length > maxBytes) throw new Error('Too large');
      return await Promise.resolve(Buffer.from(bytes));
    },
    openVerified: async ({ reference, maxBytes }) => {
      const bytes = find(reference);
      if (bytes.length > maxBytes) throw new Error('Too large');
      return await Promise.resolve({
        byteLength: bytes.length,
        sha256: reference.sha256,
        open: () =>
          Readable.from(
            (async function* () {
              for (let i = 0; i < bytes.length; i += 65536)
                yield await Promise.resolve(
                  Buffer.from(bytes.subarray(i, i + 65536)),
                );
            })(),
            { objectMode: false },
          ),
        release,
      });
    },
  };
  const beforeDispatch = vi.fn<NodeExecutionRuntime['beforeDispatch']>(() =>
    Promise.resolve(),
  );
  const runtime: NodeExecutionRuntime = {
    workspaceId: randomUUID(),
    runId: randomUUID(),
    nodeRunId: randomUUID(),
    attemptId: randomUUID(),
    attemptNumber: 1,
    nodeId: 'file',
    invocationKey: 'file',
    sideEffectClass: 'safe',
    artifacts,
    beforeDispatch,
  };
  return { data, get, add, release, write, artifacts, runtime, beforeDispatch };
}
