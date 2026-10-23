import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PutArtifactRequest } from '@pertexo/artifact-store';

import { expect, it, vi } from 'vitest';

import {
  context,
  databaseConfig,
  temporaryDirectories,
  createOwnedCapabilities,
} from '../fixture.js';

export function registerArtifactSourceCleanup(): void {
  it('preserves source and return failures after clearing an overflowing chunk', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const returnError = new Error('artifact source return failed');
    const overflow = new Uint8Array([1, 2]);
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending: vi.fn(),
          finalize: vi.fn(),
        },
        artifactStore: { put: vi.fn() },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');

    const result = await artifacts
      .write({
        body: {
          [Symbol.asyncIterator]: () => ({
            next: vi
              .fn()
              .mockResolvedValueOnce({ done: false, value: overflow }),
            return: vi.fn().mockRejectedValue(returnError),
          }),
        },
        maxBytes: 1,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(result).toMatchObject({
      safeErrorCode: 'execution.file_scratch_cleanup',
      kind: 'retry',
    });
    expect(JSON.stringify(result)).not.toContain(returnError.message);
    expect(overflow).toEqual(new Uint8Array([0, 0]));
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });

  it('closes an upload stream when the artifact store throws before reading', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const uploadError = new Error('artifact upload rejected before read');
    let uploadBody:
      | (PutArtifactRequest['body'] & {
          closed: boolean;
          destroyed: boolean;
        })
      | undefined;
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending: vi.fn().mockResolvedValue(undefined),
          finalize: vi.fn(),
        },
        artifactStore: {
          put: (request) => {
            uploadBody = request.body;
            throw uploadError;
          },
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
    ).rejects.toBe(uploadError);
    expect(uploadBody).toMatchObject({ closed: true, destroyed: true });
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });

  it('closes a late upload stream and skips finalize when cancellation wins', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const uploadResult = Promise.withResolvers<{
      artifactId: string;
      workspaceId: string;
      byteLength: number;
      mediaType: string;
      sha256: string;
    }>();
    let uploadBody:
      | (PutArtifactRequest['body'] & {
          closed: boolean;
          destroyed: boolean;
        })
      | undefined;
    const put = vi.fn((request: PutArtifactRequest) => {
      uploadBody = request.body;
      return uploadResult.promise;
    });
    const finalize = vi.fn();
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending: vi.fn().mockResolvedValue(undefined),
          finalize,
        },
        artifactStore: { put },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');
    const controller = new AbortController();
    const writing = artifacts.write({
      body: (async function* (): AsyncGenerator<Uint8Array> {
        await Promise.resolve();
        yield new Uint8Array([1]);
      })(),
      maxBytes: 1,
      mediaType: 'application/octet-stream',
      purpose: 'node-output',
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(put).toHaveBeenCalledOnce();
    });
    const request = put.mock.calls[0]?.[0];
    if (request === undefined) throw new Error('upload request missing');

    controller.abort();
    uploadResult.resolve({
      artifactId: request.artifactId,
      workspaceId: request.workspaceId,
      byteLength: request.byteLength,
      mediaType: request.mediaType,
      sha256: request.sha256,
    });
    await expect(writing).rejects.toMatchObject({ name: 'AbortError' });
    expect(uploadBody).toMatchObject({ closed: true, destroyed: true });
    expect(finalize).not.toHaveBeenCalled();
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });
}
