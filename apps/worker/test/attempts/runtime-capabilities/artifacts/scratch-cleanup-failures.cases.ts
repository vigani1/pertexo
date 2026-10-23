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

export function registerScratchCleanupFailures(): void {
  it('normalizes a non-Error spool cleanup rejection', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
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
              // Deliberately model a hostile adapter rejection.
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
              return Promise.reject(undefined);
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
        maxBytes: 1,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      safeErrorCode: 'execution.file_scratch_cleanup',
      possiblyDispatched: false,
    });
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });

  it('keeps failed directory cleanup charged and refuses fresh writes', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const cleanupError = new Error('spool directory removal failed');
    const operationError = new Error('pending metadata failed');
    const createPending = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(operationError);
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending,
          finalize: vi.fn().mockResolvedValue(undefined),
        },
        artifactStore: {
          put: async (request) => {
            for await (const _chunk of request.body) {
              // Consume the owned upload stream before acknowledging storage.
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
        artifactSpoolOperations: {
          openFile: (filePath) => open(filePath, 'wx', 0o600),
          removeDirectory: vi.fn().mockRejectedValue(cleanupError),
        },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');
    const write = () =>
      artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield new Uint8Array([1]);
        })(),
        maxBytes: 1,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      });

    await expect(write()).rejects.toMatchObject({
      safeErrorCode: 'execution.file_scratch_cleanup',
    });
    const combined = await write().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(combined).toMatchObject({
      safeErrorCode: 'execution.file_scratch_cleanup',
    });
    expect(createPending).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(combined)).not.toContain(cleanupError.message);
    await runtime.close();
  });

  it('rejects an undefined artifact operation failure and still removes its spool directory', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const put = vi.fn();
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          // Deliberately exercise a hostile non-Error adapter rejection.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          createPending: () => Promise.reject(undefined),
          finalize: vi.fn(),
        },
        artifactStore: { put },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');

    let rejection: unknown;
    let rejected = false;
    try {
      await artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield new Uint8Array([1]);
        })(),
        maxBytes: 1,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      });
    } catch (error) {
      rejected = true;
      rejection = error;
    }
    expect(rejected).toBe(true);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe(
      'Artifact operation failed with a non-Error value',
    );
    expect(Object.hasOwn(rejection as Error, 'cause')).toBe(true);
    expect((rejection as Error).cause).toBeUndefined();
    expect(put).not.toHaveBeenCalled();
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });

  it('rejects an already-aborted artifact write before creating spool data', async () => {
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
    const controller = new AbortController();
    controller.abort();

    await expect(
      artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield new Uint8Array([1]);
        })(),
        maxBytes: 1,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(put).not.toHaveBeenCalled();
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });
}
