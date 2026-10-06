import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { canonicalJson } from '@pertexo/workflow-model/canonical-json';
import { expect, it, vi } from 'vitest';
import type {
  CoordinatorRunStore,
  NativeCoordinatorControlDeclarationSource,
  NativeNodeAttemptValueSource,
} from '@pertexo/database/execution';
import { WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1 } from '@pertexo/database/execution';
import { createCoordinatorControlSourceHydration } from '../src/execution/coordinator-control-source-hydration.js';

const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const owner = {
  workspaceId: id(1),
  runId: id(2),
  workflowVersionId: id(3),
  expectedRevision: 4,
  delivery: { outboxEventId: id(4), payloadChecksum: 'a'.repeat(64) },
};
function fixture(artifact: boolean) {
  const value = {
    items: [artifact ? 'x'.repeat(300_000) : 'one'],
    iterationCount: 1,
  };
  const bytes = Buffer.from(
    artifact
      ? canonicalJson(value)
      : ' { "items": ["one"], "iterationCount": 1 } ',
  );
  const metadata = {
    workspaceId: owner.workspaceId,
    artifactId: id(6),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
    mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
  } as const;
  const source: NativeCoordinatorControlDeclarationSource = {
    sequence: 5,
    invocationKey: 'loop',
    nodeId: 'loop',
    attemptId: id(5),
    output: artifact
      ? { kind: 'artifact', artifactId: id(6) }
      : { kind: 'inline', attemptId: id(5) },
    controlKind: 'for_each',
    branchPath: [],
    iterationPath: [],
    valueSource: {
      slot: 'upstream_output',
      source: {
        kind: 'physical_output',
        workspaceId: owner.workspaceId,
        runId: owner.runId,
        workflowVersionId: owner.workflowVersionId,
        nodeId: 'loop',
        invocationKey: 'loop',
        attemptId: id(5),
        provenanceId: id(7),
      },
      valueIdentity: {
        reference: artifact
          ? { schemaVersion: 1, kind: 'artifact', artifactId: id(6) }
          : { schemaVersion: 1, kind: 'inline' },
        sha256: metadata.sha256,
        byteLength: metadata.byteLength,
        mediaType: metadata.mediaType,
      },
    },
  };
  const valueSource: NativeNodeAttemptValueSource = {
    slot: 'upstream_output',
    source: source.valueSource.source,
    snapshot: {
      reference: artifact
        ? { schemaVersion: 1, kind: 'artifact', artifactId: id(6) }
        : { schemaVersion: 1, kind: 'inline', value },
      sha256: metadata.sha256,
      byteLength: metadata.byteLength,
      ...(!artifact ? { serializedValue: bytes.toString('utf8') } : {}),
    },
  };
  const read = vi.fn<
    NonNullable<CoordinatorRunStore['readCoordinatorControlSource']>
  >(() =>
    Promise.resolve({
      kind: 'ready',
      valueSource: structuredClone(valueSource),
    }),
  );
  const getStream = vi.fn(() =>
    Promise.resolve({ metadata, body: Readable.from([Buffer.from(bytes)]) }),
  );
  const hydrate = createCoordinatorControlSourceHydration(
    { readCoordinatorControlSource: read },
    2000,
    { getStream },
  );
  return { hydrate, read, getStream, value, valueSource, source };
}

it.each([false, true])(
  'hydrates original bytes with fresh selected reads before and after codec work (artifact=%s)',
  async (artifact) => {
    const f = fixture(artifact);
    const signal = new AbortController().signal;
    const first = await f.hydrate({ owner, source: f.source, signal });
    const second = await f.hydrate({ owner, source: f.source, signal });
    expect(first).toEqual(f.value);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(f.read).toHaveBeenCalledTimes(6);
    expect(f.getStream).toHaveBeenCalledTimes(artifact ? 2 : 0);
    for (const [request] of f.read.mock.calls) {
      expect(request.signal).toBe(signal);
      expect(request.owner).toEqual(owner);
      expect(request.source).toEqual(f.source);
    }
  },
);

it('rejects selected metadata drift before reading an object', async () => {
  const f = fixture(true);
  f.read.mockResolvedValueOnce({
    kind: 'ready',
    valueSource: {
      ...f.valueSource,
      snapshot: { ...f.valueSource.snapshot, sha256: 'b'.repeat(64) },
    },
  });
  await expect(
    f.hydrate({
      owner,
      source: f.source,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('original source differs');
  expect(f.getStream).not.toHaveBeenCalled();
});

it('rejects metadata drift on the independently repeated codec authorization', async () => {
  const f = fixture(true);
  f.read.mockResolvedValueOnce({ kind: 'ready', valueSource: f.valueSource });
  f.read.mockResolvedValueOnce({
    kind: 'ready',
    valueSource: {
      ...f.valueSource,
      snapshot: { ...f.valueSource.snapshot, sha256: 'b'.repeat(64) },
    },
  });
  await expect(
    f.hydrate({
      owner,
      source: f.source,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('original source differs');
  expect(f.getStream).not.toHaveBeenCalled();
});

it('joins an in-flight read on abort and does not start codec or storage work', async () => {
  const f = fixture(true);
  const controller = new AbortController();
  const deferred =
    Promise.withResolvers<
      Awaited<
        ReturnType<
          NonNullable<CoordinatorRunStore['readCoordinatorControlSource']>
        >
      >
    >();
  f.read.mockImplementationOnce(() => deferred.promise);
  let settled = false;
  const pending = f.hydrate({
    owner,
    source: f.source,
    signal: controller.signal,
  });
  void pending.catch(() => {
    settled = true;
  });
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  deferred.resolve({ kind: 'ready', valueSource: f.valueSource });
  await expect(pending).rejects.toMatchObject({
    stop: { kind: 'context_aborted' },
  });
  expect(f.getStream).not.toHaveBeenCalled();
  expect(f.read).toHaveBeenCalledTimes(1);
});

it('rejects source drift after the original artifact stream has been consumed', async () => {
  const f = fixture(true);
  f.read.mockResolvedValueOnce({ kind: 'ready', valueSource: f.valueSource });
  f.read.mockResolvedValueOnce({ kind: 'ready', valueSource: f.valueSource });
  f.read.mockResolvedValueOnce({
    kind: 'ready',
    valueSource: {
      ...f.valueSource,
      snapshot: { ...f.valueSource.snapshot, sha256: 'b'.repeat(64) },
    },
  });
  await expect(
    f.hydrate({
      owner,
      source: f.source,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('original source differs');
  expect(f.getStream).toHaveBeenCalledTimes(1);
  expect(f.read).toHaveBeenCalledTimes(3);
});

it('preserves a typed source outage without using stale bytes', async () => {
  const f = fixture(true);
  f.read.mockResolvedValueOnce({
    kind: 'stopped',
    stop: { kind: 'unavailable', reason: 'source_read_failed' },
  });
  await expect(
    f.hydrate({
      owner,
      source: f.source,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({
    stop: { kind: 'unavailable', reason: 'source_read_failed' },
  });
  expect(f.getStream).not.toHaveBeenCalled();
});
