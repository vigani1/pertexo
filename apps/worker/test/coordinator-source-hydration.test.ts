import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
  NativeNodeAttemptValueSource,
  ReadCallableCompletionSource,
} from '@pertexo/database/execution';
import { createCoordinatorSourceHydration } from '../src/execution/coordinator-source-hydration.js';

const id = (n: number) =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const consumer = {
  workspaceId: id(1),
  runId: id(2),
  workflowVersionId: id(3),
  expectedRevision: 0,
  delivery: { outboxEventId: id(4), payloadChecksum: 'a'.repeat(64) },
};
const source: NativeNodeAttemptValueSource = {
  slot: 'run_input',
  source: {
    kind: 'run_input',
    provenanceId: id(5),
    workspaceId: id(1),
    runId: id(2),
    workflowVersionId: id(3),
  },
  snapshot: {
    reference: { schemaVersion: 1, kind: 'inline', value: null },
    serializedValue: 'null',
    byteLength: 4,
    sha256: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
  },
};
const request = () => ({
  owner: { kind: 'run_result' as const, ...consumer },
  source,
  signal: new AbortController().signal,
});

describe('production coordinator source hydration composition (external owner port)', () => {
  it.each(['wait_resume_output', 'structured_collection'] as const)(
    'refuses attempt-only %s slots before any coordinator read',
    async (slot) => {
      const physical = {
        kind: 'physical_output' as const,
        workspaceId: id(1),
        runId: id(2),
        workflowVersionId: id(3),
        provenanceId: id(5),
        nodeId: 'loop',
        invocationKey: 'declaration-scope',
        attemptId: id(6),
      };
      const valueSource: NativeNodeAttemptValueSource =
        slot === 'wait_resume_output'
          ? { slot, source: physical, snapshot: source.snapshot }
          : {
              slot,
              source: {
                ...physical,
                collection: {
                  loopNodeId: 'loop',
                  ordinal: 0,
                  collectionSize: 1,
                  declaredCollectionChecksum: 'a'.repeat(64),
                },
              },
              snapshot: source.snapshot,
            };
      const read = vi.fn<ReadCallableCompletionSource>();
      await expect(
        createCoordinatorSourceHydration(
          { readCallableCompletionSource: read },
          250,
        )({ ...request(), source: valueSource }),
      ).rejects.toThrow('Coordinator source consumer scope differs');
      expect(read).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    'hydrates exact accepted artifact bytes, or refuses a substituted checksum (%s) before storage',
    async (substituted) => {
      const value = { name: 'x'.repeat(300_000) };
      const bytes = Buffer.from(JSON.stringify(value));
      const metadata = {
        artifactId: id(7),
        workspaceId: id(1),
        byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mediaType: 'application/vnd.pertexo.execution-value+json;version=1',
      };
      const artifact: NativeNodeAttemptValueSource = {
        ...source,
        snapshot: {
          reference: { schemaVersion: 1, kind: 'artifact', artifactId: id(7) },
          sha256: metadata.sha256,
          byteLength: bytes.length,
        },
      };
      const read = vi.fn<ReadCallableCompletionSource>(() =>
        Promise.resolve({
          kind: 'ready',
          valueSource: substituted
            ? {
                ...artifact,
                snapshot: { ...artifact.snapshot, sha256: 'a'.repeat(64) },
              }
            : artifact,
        }),
      );
      const getStream = vi.fn(() =>
        Promise.resolve({ body: Readable.from([bytes]), metadata }),
      );
      const hydrated = createCoordinatorSourceHydration(
        { readCallableCompletionSource: read },
        250,
        { getStream },
      )({ ...request(), source: artifact });
      if (substituted) {
        await expect(hydrated).rejects.toThrow('byte identity does not agree');
        expect(getStream).not.toHaveBeenCalled();
      } else {
        await expect(hydrated).resolves.toEqual(value);
        expect(getStream).toHaveBeenCalledOnce();
      }
      expect(read).toHaveBeenCalledOnce();
    },
  );
  it('independently rereads even inline bytes under the exact current consumer and budget', async () => {
    const read = vi.fn<ReadCallableCompletionSource>(() =>
      Promise.resolve({ kind: 'ready', valueSource: source }),
    );
    const hydrate = createCoordinatorSourceHydration(
      { readCallableCompletionSource: read },
      250,
    );
    const input = request();
    await expect(hydrate(input)).resolves.toBeNull();
    expect(read).toHaveBeenCalledExactlyOnceWith({
      owner: consumer,
      source: {
        slot: 'run_input',
        source: source.source,
        valueIdentity: {
          reference: { schemaVersion: 1, kind: 'inline' },
          sha256: source.snapshot.sha256,
          byteLength: 4,
          mediaType: 'application/vnd.pertexo.execution-value+json;version=1',
        },
      },
      signal: input.signal,
      readTimeoutMillis: 250,
    });
  });
  it('propagates current owner stop without treating the supplied snapshot as authority', async () => {
    const read: ReadCallableCompletionSource = () =>
      Promise.resolve({ kind: 'stopped', stop: { kind: 'canceled' } });
    await expect(
      createCoordinatorSourceHydration(
        { readCallableCompletionSource: read },
        250,
      )(request()),
    ).rejects.toMatchObject({ stop: { kind: 'canceled' } });
  });
  it('refuses an independently returned historical source with the same bytes but different scope', async () => {
    const read: ReadCallableCompletionSource = () =>
      Promise.resolve({
        kind: 'ready',
        valueSource: {
          ...source,
          source: { ...source.source, provenanceId: id(6) },
        },
      });
    await expect(
      createCoordinatorSourceHydration(
        { readCallableCompletionSource: read },
        250,
      )(request()),
    ).rejects.toThrow('independently accepted source scope differs');
  });
  it('starts no owner read after cancellation', async () => {
    const read = vi.fn<ReadCallableCompletionSource>();
    const input = request();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createCoordinatorSourceHydration(
        { readCallableCompletionSource: read },
        250,
      )({ ...input, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });
  it('fails closed without the actual native port', async () => {
    await expect(
      createCoordinatorSourceHydration({}, 250)(request()),
    ).rejects.toThrow('source owner is unavailable');
  });
});
