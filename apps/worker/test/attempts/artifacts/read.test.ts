import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactIntegrityError } from '@pertexo/artifact-store';
import { ArtifactMetadataNotFoundError } from '@pertexo/database/runs';
import { createArtifactReader } from '../../../src/attempts/artifacts/read.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const reference = {
  artifactId: '22222222-2222-4222-8222-222222222222',
  byteLength: 4,
  mediaType: 'application/octet-stream',
  sha256: 'a'.repeat(64),
};
function fixture(
  chunks: readonly Uint8Array[] = [new Uint8Array([0, 255, 128, 42])],
  patch: Partial<typeof reference> = {},
) {
  const body = Readable.from(chunks);
  const requireReadable = vi.fn().mockResolvedValue(undefined);
  const getStream = vi.fn().mockResolvedValue({
    body,
    metadata: { workspaceId, ...reference, ...patch },
  });
  const read = createArtifactReader({
    workspaceId,
    requireReadable,
    store: { getStream },
  });
  return {
    body,
    requireReadable,
    getStream,
    read,
    signal: new AbortController().signal,
  };
}
describe('bounded verified artifact reads', () => {
  it('authorizes the bound workspace before returning exact bytes and releasing the stream', async () => {
    const state = fixture();
    await expect(
      state.read({ reference, maxBytes: 1048576, signal: state.signal }),
    ).resolves.toEqual(new Uint8Array([0, 255, 128, 42]));
    expect(state.requireReadable).toHaveBeenCalledWith(reference, state.signal);
    expect(state.getStream).toHaveBeenCalledWith({
      artifactId: reference.artifactId,
      workspaceId,
      signal: state.signal,
    });
    expect(state.body.destroyed).toBe(true);
  });
  it('supports an empty body', async () => {
    const state = fixture([], { byteLength: 0 });
    await expect(
      state.read({
        reference: { ...reference, byteLength: 0 },
        maxBytes: 1048576,
        signal: state.signal,
      }),
    ).resolves.toEqual(new Uint8Array());
  });
  it('rejects the real oversized declaration before storage or authorization', async () => {
    const state = fixture();
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
    const state = fixture();
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
    const state = fixture(undefined, patch);
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
      const state = fixture([chunk]);
      await expect(
        state.read({ reference, maxBytes: 1048576, signal: state.signal }),
      ).rejects.toMatchObject({ kind: 'failed', possiblyDispatched: false });
      expect(state.body.destroyed).toBe(true);
    },
  );
  it('consumes verification through EOF and fails on a late checksum rejection', async () => {
    const state = fixture();
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
    const state = fixture();
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
    const state = fixture(chunks, { byteLength: count });
    const bytes = await state.read({
      reference: { ...reference, byteLength: count },
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
