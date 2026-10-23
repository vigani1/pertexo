import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

import {
  previewRunId,
  context,
  databaseConfig,
  temporaryDirectories,
  createOwnedCapabilities,
} from '../fixture.js';

export function registerGeneratedArtifactIdentities(): void {
  it('generates UUIDv7 identities for persisted artifacts by default', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const createPending = vi.fn(() => Promise.resolve());
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending,
          finalize: vi.fn(() => Promise.resolve()),
        },
        artifactStore: {
          put: async (request) => {
            for await (const _chunk of request.body) {
              // Drain the body; the chunks are not needed.
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
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');

    const reference = await artifacts.write({
      body: (async function* (): AsyncGenerator<Uint8Array> {
        await Promise.resolve();
        yield new Uint8Array([1]);
      })(),
      maxBytes: 1,
      mediaType: 'application/octet-stream',
      purpose: 'node-output',
      signal: new AbortController().signal,
    });

    expect(reference.artifactId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: reference.artifactId }),
    );
    await runtime.close();
  });

  it('caps artifact retention at the owning preview deadline', async () => {
    const createPending = vi.fn(() => Promise.resolve());
    const now = new Date('2026-08-22T12:00:00.000Z');
    const previewDeadline = new Date(now.getTime() + 10_000);
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig, artifactRetentionMillis: 60_000 },
      {
        artifactPersistence: {
          createPending,
          finalize: vi.fn(() => Promise.resolve()),
        },
        artifactStore: {
          put: async (request) => {
            for await (const _chunk of request.body) {
              // Drain the body; the chunks are not needed.
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
        now: () => now,
      },
    );
    const artifacts = runtime.factories.artifacts?.({
      ...context,
      artifactRetentionDeadline: previewDeadline,
      previewRunId,
    });
    if (artifacts === undefined) throw new Error('artifact capability missing');

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

    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: previewDeadline,
        previewRunId,
      }),
    );
    await runtime.close();
  });

  it.each([0, 1.5, 10_485_761])(
    'rejects invalid artifact byte limit %s',
    async (maxBytes) => {
      const runtime = await createOwnedCapabilities(
        { database: databaseConfig },
        {
          artifactPersistence: { createPending: vi.fn(), finalize: vi.fn() },
          artifactStore: { put: vi.fn() },
        },
      );
      const artifacts = runtime.factories.artifacts?.(context);
      if (artifacts === undefined)
        throw new Error('artifact capability missing');
      await expect(
        artifacts.write({
          body: (async function* (): AsyncGenerator<Uint8Array> {
            await Promise.resolve();
            yield new Uint8Array();
          })(),
          maxBytes,
          mediaType: 'text/plain',
          purpose: 'test',
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(TypeError);
      await runtime.close();
    },
  );

  it('rejects an artifact whose retention deadline has passed', async () => {
    const artifactRetentionDeadline = new Date('2026-08-22T11:59:59.000Z');
    const now = new Date('2026-08-22T12:00:00.000Z');
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: { createPending: vi.fn(), finalize: vi.fn() },
        artifactStore: { put: vi.fn() },
        now: () => now,
      },
    );
    const artifacts = runtime.factories.artifacts?.({
      ...context,
      artifactRetentionDeadline,
    });
    if (artifacts === undefined) throw new Error('artifact capability missing');
    await expect(
      artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield new Uint8Array();
        })(),
        maxBytes: 1,
        mediaType: 'text/plain',
        purpose: 'test',
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    await runtime.close();
  });
}
