import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

import {
  context,
  databaseConfig,
  temporaryDirectories,
  createOwnedCapabilities,
} from '../fixture.js';

export function registerVerifiedArtifactReads(): void {
  it.each([
    ['empty', [] as number[]],
    ['short writes', [1, 2, 3]],
  ] as const)(
    'supports %s while preserving the exact byte count',
    async (mode, bytes) => {
      const spoolDirectory = await mkdtemp(
        path.join(tmpdir(), 'pertexo-capability-test-'),
      );
      temporaryDirectories.push(spoolDirectory);
      const uploaded: number[] = [];
      const runtime = await createOwnedCapabilities(
        { database: databaseConfig },
        {
          artifactPersistence: {
            createPending: vi.fn().mockResolvedValue(undefined),
            finalize: vi.fn().mockResolvedValue(undefined),
          },
          artifactStore: {
            put: async (request) => {
              for await (const chunk of request.body) {
                const value: unknown = chunk;
                if (!(value instanceof Uint8Array))
                  throw new TypeError('artifact chunk is not bytes');
                uploaded.push(...value);
              }
              return {
                artifactId: request.artifactId,
                workspaceId: request.workspaceId,
                byteLength: request.byteLength,
                mediaType: request.mediaType,
                sha256: request.sha256,
              };
            },
          },
          ...(mode === 'short writes'
            ? {
                artifactSpoolOperations: {
                  openFile: async (filePath: string) => {
                    const file = await open(filePath, 'wx', 0o600);
                    const write = file.write.bind(file);
                    file.write = ((
                      buffer: Uint8Array,
                      offset: number,
                      _length: number,
                      position: number | null,
                    ) => write(buffer, offset, 1, position)) as never;
                    return file;
                  },
                  removeDirectory: (directory: string) =>
                    rm(directory, { recursive: true, force: true }),
                },
              }
            : {}),
          spoolDirectory,
        },
      );
      const artifacts = runtime.factories.artifacts?.(context);
      if (artifacts === undefined)
        throw new Error('artifact capability missing');
      const source = Uint8Array.from(bytes);

      const reference = await artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          if (source.byteLength > 0) yield source;
        })(),
        maxBytes: Math.max(1, source.byteLength),
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      });
      expect(reference.byteLength).toBe(source.byteLength);
      expect(uploaded).toEqual(bytes);
      expect(source.every((byte) => byte === 0)).toBe(true);
      expect(await readdir(spoolDirectory)).toEqual([]);
      await runtime.close();
    },
  );

  it('does not upload or leave spool data when the bounded stream overflows', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const put = vi.fn();
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending: vi.fn(),
          finalize: vi.fn(),
        },
        artifactStore: { put },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');
    const overflow = new Uint8Array([1, 2, 3]);

    await expect(
      artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield overflow;
        })(),
        maxBytes: 2,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      safeErrorCode: 'execution.file_size',
      kind: 'failed',
    });
    expect(overflow).toEqual(new Uint8Array([0, 0, 0]));
    expect(put).not.toHaveBeenCalled();
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });

  it('requests source return on abort, awaits the pending chunk, and clears it', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const pendingChunk = Promise.withResolvers<IteratorResult<Uint8Array>>();
    const next = vi.fn().mockReturnValue(pendingChunk.promise);
    const returnIterator = vi.fn().mockResolvedValue({
      done: true as const,
      value: undefined,
    });
    const put = vi.fn();
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending: vi.fn(),
          finalize: vi.fn(),
        },
        artifactStore: { put },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');
    const controller = new AbortController();
    const chunk = new Uint8Array([7, 8]);
    const written = artifacts.write({
      body: {
        [Symbol.asyncIterator]: () => ({ next, return: returnIterator }),
      },
      maxBytes: 2,
      mediaType: 'application/octet-stream',
      purpose: 'node-output',
      signal: controller.signal,
    });
    const settled = vi.fn();
    void written.then(settled, settled);
    await vi.waitFor(() => {
      expect(next).toHaveBeenCalledOnce();
    });

    controller.abort();
    await vi.waitFor(() => {
      expect(returnIterator).toHaveBeenCalledOnce();
    });
    expect(settled).not.toHaveBeenCalled();
    pendingChunk.resolve({ done: false, value: chunk });
    await expect(written).rejects.toMatchObject({ kind: 'canceled' });
    expect(chunk).toEqual(new Uint8Array([0, 0]));
    expect(put).not.toHaveBeenCalled();
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });
}
