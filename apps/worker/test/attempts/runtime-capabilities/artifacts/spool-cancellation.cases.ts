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

export function registerSpoolCancellation(): void {
  it('awaits an in-flight spool write after cancellation and then clears its chunk', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const writeResult = Promise.withResolvers<{ bytesWritten: number }>();
    const write = vi.fn().mockReturnValue(writeResult.promise);
    const put = vi.fn();
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending: vi.fn(),
          finalize: vi.fn(),
        },
        artifactStore: { put },
        artifactSpoolOperations: {
          openFile: async (filePath) => {
            const file = await open(filePath, 'wx', 0o600);
            file.write = write as never;
            return file;
          },
          removeDirectory: (directory) =>
            rm(directory, { recursive: true, force: true }),
        },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');
    const controller = new AbortController();
    const chunk = new Uint8Array([9]);
    const writing = artifacts.write({
      body: (async function* (): AsyncGenerator<Uint8Array> {
        await Promise.resolve();
        yield chunk;
      })(),
      maxBytes: 1,
      mediaType: 'application/octet-stream',
      purpose: 'node-output',
      signal: controller.signal,
    });
    const settled = vi.fn();
    void writing.then(settled, settled);
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledOnce();
    });

    controller.abort();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(chunk).toEqual(new Uint8Array([9]));
    writeResult.resolve({ bytesWritten: 1 });
    await expect(writing).rejects.toMatchObject({ kind: 'canceled' });
    expect(chunk).toEqual(new Uint8Array([0]));
    expect(put).not.toHaveBeenCalled();
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });

  it('rejects a zero-progress spool write without uploading or leaking data', async () => {
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
        artifactSpoolOperations: {
          openFile: async (filePath) => {
            const file = await open(filePath, 'wx', 0o600);
            file.write = vi.fn().mockResolvedValue({ bytesWritten: 0 });
            return file;
          },
          removeDirectory: (directory) =>
            rm(directory, { recursive: true, force: true }),
        },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');

    await expect(
      artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield new Uint8Array([1]);
        })(),
        maxBytes: 1,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      safeErrorCode: 'execution.file_scratch_io',
      possiblyDispatched: false,
    });
    expect(put).not.toHaveBeenCalled();
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });

  it('refuses more writes after a file-close failure and still removes the owned directory', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const sourceError = new Error('injected artifact source failure');
    const closeError = new Error('injected spool close failure');
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending: vi.fn(),
          finalize: vi.fn(),
        },
        artifactStore: { put: vi.fn() },
        artifactSpoolOperations: {
          openFile: async (filePath) => {
            const file = await open(filePath, 'wx', 0o600);
            const closeFile = file.close.bind(file);
            file.close = vi.fn(async () => {
              await closeFile();
              throw closeError;
            });
            return file;
          },
          removeDirectory: (directory) =>
            rm(directory, { recursive: true, force: true }),
        },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');

    await expect(
      artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield new Uint8Array([1]);
        })(),
        maxBytes: 2,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      safeErrorCode: 'execution.file_scratch_cleanup',
    });
    await expect(
      artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield new Uint8Array([1]);
          throw sourceError;
        })(),
        maxBytes: 2,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      safeErrorCode: 'execution.file_scratch_cleanup',
    });
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });
}
