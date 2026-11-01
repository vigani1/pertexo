import { createHttpRequestExecutorRegistration } from '@pertexo/integrations/server';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactScratchSpace } from '../../../src/attempts/artifacts/scratch/space.js';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactIntegrityError } from '@pertexo/artifact-store';
import { ArtifactMetadataNotFoundError } from '@pertexo/core/runs';
import { createArtifactReader } from '../../../src/attempts/artifacts/read.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const reference = {
  artifactId: '22222222-2222-4222-8222-222222222222',
  byteLength: 4,
  mediaType: 'application/octet-stream',
  sha256: createHash('sha256')
    .update(new Uint8Array([0, 255, 128, 42]))
    .digest('hex'),
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture(
  chunks: readonly Uint8Array[] = [new Uint8Array([0, 255, 128, 42])],
  patch: Partial<typeof reference> = {},
  maximumBytes = 10485760,
) {
  const body = Readable.from(chunks);
  const requireReadable = vi.fn().mockResolvedValue(undefined);
  const getStream = vi.fn().mockResolvedValue({
    body,
    metadata: { workspaceId, ...reference, ...patch },
  });
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pertexo-verified-read-'),
  );
  directories.push(directory);
  const { read, openVerified } = createArtifactReader({
    scratch: await ArtifactScratchSpace.create(directory),
    attemptId: 'attempt',
    maximumBytes,
    assertOpen: () => undefined,
    workspaceId,
    requireReadable,
    store: { getStream },
  });
  if (read === undefined || openVerified === undefined)
    throw new Error('Reader missing');
  return {
    body,
    requireReadable,
    getStream,
    read,
    openVerified,
    directory,
    signal: new AbortController().signal,
  };
}
describe('bounded verified artifact reads', () => {
  it('authorizes the bound workspace before returning exact bytes and releasing the stream', async () => {
    const state = await fixture();
    await expect(
      state.read({ reference, maxBytes: 1048576, signal: state.signal }),
    ).resolves.toEqual(new Uint8Array([0, 255, 128, 42]));
    expect(state.requireReadable).toHaveBeenCalledWith(
      reference,
      expect.any(AbortSignal),
    );
    expect(state.getStream.mock.calls[0]?.[0]).toMatchObject({
      artifactId: reference.artifactId,
      workspaceId,
    });
    expect(state.body.destroyed).toBe(true);
  });
  it('supports an empty body', async () => {
    const sha256 = createHash('sha256').digest('hex');
    const state = await fixture([], { byteLength: 0, sha256 });
    await expect(
      state.read({
        reference: { ...reference, byteLength: 0, sha256 },
        maxBytes: 1048576,
        signal: state.signal,
      }),
    ).resolves.toEqual(new Uint8Array());
  });
  it('rejects the real oversized declaration before storage or authorization', async () => {
    const state = await fixture();
    await expect(
      state.read({
        reference: { ...reference, byteLength: 1048577 },
        maxBytes: 1048576,
        signal: state.signal,
      }),
    ).rejects.toMatchObject({
      kind: 'failed',
      errorKind: 'configuration',
      possiblyDispatched: false,
    });
    expect(state.requireReadable).not.toHaveBeenCalled();
    expect(state.getStream).not.toHaveBeenCalled();
  });
  it('rejects unavailable metadata before object-store access', async () => {
    const state = await fixture();
    state.requireReadable.mockRejectedValue(
      new ArtifactMetadataNotFoundError(),
    );
    await expect(
      state.read({ reference, maxBytes: 1048576, signal: state.signal }),
    ).rejects.toMatchObject({ kind: 'failed', possiblyDispatched: false });
    expect(state.getStream).not.toHaveBeenCalled();
  });
  it.each([
    { sha256: 'b'.repeat(64) },
    { byteLength: 5 },
    { mediaType: 'text/plain' },
    { artifactId: '33333333-3333-4333-8333-333333333333' },
  ])('rejects changed store metadata %#', async (patch) => {
    const state = await fixture(undefined, patch);
    await expect(
      state.read({ reference, maxBytes: 1048576, signal: state.signal }),
    ).rejects.toMatchObject({
      kind: 'failed',
      errorKind: 'configuration',
      possiblyDispatched: false,
    });
    expect(state.body.destroyed).toBe(true);
  });
  it.each([[new Uint8Array(5)], [new Uint8Array(3)]])(
    'rejects a body with an incorrect actual length %#',
    async (chunk) => {
      const state = await fixture([chunk]);
      await expect(
        state.read({ reference, maxBytes: 1048576, signal: state.signal }),
      ).rejects.toMatchObject({ kind: 'failed', possiblyDispatched: false });
      expect(state.body.destroyed).toBe(true);
    },
  );
  it('consumes verification through EOF and fails on a late checksum rejection', async () => {
    const state = await fixture();
    const body = Readable.from(
      (async function* () {
        yield new Uint8Array(4);
        await Promise.resolve();
        throw new ArtifactIntegrityError('Checksum mismatch');
      })(),
    );
    state.getStream.mockResolvedValue({
      body,
      metadata: { workspaceId, ...reference },
    });
    await expect(
      state.read({ reference, maxBytes: 1048576, signal: state.signal }),
    ).rejects.toMatchObject({ kind: 'failed', possiblyDispatched: false });
    expect(body.destroyed).toBe(true);
  });
  it('classifies storage outages as pre-dispatch retry and cancellation as canceled', async () => {
    const state = await fixture();
    state.getStream.mockRejectedValue(new Error('Storage unavailable'));
    await expect(
      state.read({ reference, maxBytes: 1048576, signal: state.signal }),
    ).rejects.toMatchObject({
      kind: 'retry',
      errorKind: 'network',
      possiblyDispatched: false,
    });
    const controller = new AbortController();
    controller.abort();
    state.getStream.mockClear();
    await expect(
      state.read({ reference, maxBytes: 1048576, signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'canceled', possiblyDispatched: false });
    expect(state.getStream).not.toHaveBeenCalled();
  });
  it('reads the exact maximum without exceeding the supplied budget', async () => {
    const count = 1048576;
    const chunks = Array.from({ length: 16 }, () =>
      new Uint8Array(65536).fill(255),
    );
    const hash = createHash('sha256');
    for (const chunk of chunks) hash.update(chunk);
    const sha256 = hash.digest('hex');
    const state = await fixture(chunks, { byteLength: count, sha256 });
    const bytes = await state.read({
      reference: { ...reference, byteLength: count, sha256 },
      maxBytes: count,
      signal: state.signal,
    });
    expect(bytes.byteLength).toBe(count);
    expect(bytes.every((value) => value === 255)).toBe(true);
    expect(chunks.every((chunk) => chunk.every((value) => value === 0))).toBe(
      true,
    );
  });
});

it('verifies ten MiB through EOF before allowing a bounded native read and releases every disk file', async () => {
  const chunks = Array.from({ length: 160 }, (_, index) =>
    new Uint8Array(65536).fill(index),
  );
  const hash = createHash('sha256');
  for (const chunk of chunks) hash.update(chunk);
  const large = {
    ...reference,
    byteLength: 10485760,
    sha256: hash.digest('hex'),
  };
  const state = await fixture(chunks, large);
  const source = await state.openVerified({
    reference: large,
    maxBytes: large.byteLength,
    signal: state.signal,
  });
  expect(state.body.closed).toBe(true);
  const received = createHash('sha256');
  let count = 0;
  for await (const value of source.open(state.signal)) {
    const chunk: unknown = value;
    if (!(chunk instanceof Uint8Array)) throw new Error('Expected bytes');
    expect(chunk.byteLength).toBeLessThanOrEqual(65536);
    received.update(chunk);
    count += chunk.byteLength;
  }
  expect(count).toBe(large.byteLength);
  expect(received.digest('hex')).toBe(large.sha256);
  await source.release();
  expect(await readdir(state.directory)).toEqual([]);
});
it('refuses a one-byte-over declaration before authorization or storage', async () => {
  const state = await fixture();
  await expect(
    state.openVerified({
      reference: { ...reference, byteLength: 10485761 },
      maxBytes: 10485760,
      signal: state.signal,
    }),
  ).rejects.toMatchObject({ kind: 'failed' });
  expect(state.getStream).not.toHaveBeenCalled();
  expect(state.requireReadable).not.toHaveBeenCalled();
});
it('independently refuses wrong SHA even when a storage adapter ends without an integrity error', async () => {
  const state = await fixture([new Uint8Array([0, 255, 128, 43])]);
  await expect(
    state.openVerified({ reference, maxBytes: 10485760, signal: state.signal }),
  ).rejects.toMatchObject({ diagnostic: { reason: 'file_integrity' } });
  expect(await readdir(state.directory)).toEqual([]);
});

it('does not call the HTTP service or dispatch fence when EOF verification fails', async () => {
  const state = await fixture();
  const body = Readable.from(
    (async function* () {
      yield new Uint8Array([0, 255, 128, 42]);
      await Promise.resolve();
      throw new ArtifactIntegrityError('Late rejection');
    })(),
  );
  state.getStream.mockResolvedValue({
    body,
    metadata: { workspaceId, ...reference },
  });
  const beforeDispatch = vi.fn();
  const executeStreaming = vi.fn();
  const executor = createHttpRequestExecutorRegistration({
    httpClient: { executeStreaming },
  });
  await expect(
    executor.execute({
      config: {
        method: 'POST',
        url: 'https://owned.example.test/upload',
        headers: {},
        timeoutMillis: 1000,
        maxRedirects: 0,
        maxResponseBytes: 1024,
        inlineResponseBytes: 1024,
      },
      input: { body: { kind: 'artifact', ...reference } },
      connectionRefs: {},
      signal: state.signal,
      runtime: {
        workspaceId,
        runId: 'run',
        nodeRunId: 'node',
        attemptId: 'attempt',
        attemptNumber: 1,
        nodeId: 'http',
        invocationKey: 'root',
        sideEffectClass: 'unsafe',
        beforeDispatch,
        artifacts: { openVerified: state.openVerified, write: vi.fn() },
      },
    }),
  ).rejects.toMatchObject({
    kind: 'failed',
    diagnostic: { reason: 'file_integrity' },
    possiblyDispatched: false,
  });
  expect(beforeDispatch).not.toHaveBeenCalled();
  expect(executeStreaming).not.toHaveBeenCalled();
  expect(await readdir(state.directory)).toEqual([]);
});

it('keeps a lower configured store ceiling before authorization or storage access', async () => {
  const state = await fixture(undefined, {}, 3);
  await expect(
    state.openVerified({ reference, maxBytes: 10485760, signal: state.signal }),
  ).rejects.toMatchObject({ diagnostic: { reason: 'file_size' } });
  expect(state.requireReadable).not.toHaveBeenCalled();
  expect(state.getStream).not.toHaveBeenCalled();
});
