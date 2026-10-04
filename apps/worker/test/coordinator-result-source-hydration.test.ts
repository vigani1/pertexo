import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type {
  CoordinatorRunStore,
  NativeCallableValueDescriptor,
  NativeCoordinatorMaterialDemand,
  NativeCoordinatorValueOwner,
  NativeNodeAttemptValueSource,
} from '@pertexo/database/execution';
import {
  prepareInlineWorkflowExecutionValueV3,
  WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
} from '@pertexo/database/execution';
import { createCoordinatorResultSourceHydration } from '../src/execution/coordinator-result-source-hydration.js';
import { COORDINATOR_VALUE_WORK_POLICY_DEFAULTS } from '../src/execution/coordinator-value-work-lifetime.js';
import { createWorkflowExecutionValueCodec } from '../src/execution/workflow-execution-value-codec.js';

const owner: NativeCoordinatorValueOwner = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  workflowVersionId: '33333333-3333-4333-8333-333333333333',
  expectedRevision: 4,
  delivery: {
    outboxEventId: '44444444-4444-4444-8444-444444444444',
    payloadChecksum: 'a'.repeat(64),
  },
};
const demand: NativeCoordinatorMaterialDemand = {
  expectedRevision: 4,
  resultSelector: { kind: 'run_input', path: '$' },
  requiresRunInput: true,
  sources: [],
};

function fixture(artifact: boolean) {
  const id = '55555555-5555-4555-8555-555555555555';
  // Inline original whitespace stays intact; artifact bodies obey the existing
  // canonical-byte contract. Neither source is replaced before verification.
  const bytes = Buffer.from(artifact ? '{"answer":42}' : '{ "answer" : 42 }');
  const metadata = {
    artifactId: id,
    workspaceId: owner.workspaceId,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
    mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
  } as const;
  const source: Extract<NativeNodeAttemptValueSource, { slot: 'run_input' }> = {
    slot: 'run_input',
    source: {
      kind: 'run_input',
      workspaceId: owner.workspaceId,
      runId: owner.runId,
      workflowVersionId: owner.workflowVersionId,
      provenanceId: id,
    },
    snapshot: {
      reference: artifact
        ? { schemaVersion: 1, kind: 'artifact', artifactId: id }
        : { schemaVersion: 1, kind: 'inline', value: { answer: 42 } },
      sha256: metadata.sha256,
      byteLength: metadata.byteLength,
      ...(!artifact ? { serializedValue: bytes.toString('utf8') } : {}),
    },
  };
  const descriptor: Extract<
    NativeCallableValueDescriptor,
    { slot: 'run_input' }
  > = {
    slot: 'run_input',
    source: source.source,
    valueIdentity: {
      reference: artifact
        ? { schemaVersion: 1, kind: 'artifact', artifactId: id }
        : { schemaVersion: 1, kind: 'inline' },
      sha256: metadata.sha256,
      byteLength: metadata.byteLength,
      mediaType: metadata.mediaType,
    },
  };
  const load = vi.fn<
    NonNullable<CoordinatorRunStore['loadCallableCompletionSources']>
  >(() =>
    Promise.resolve({
      kind: 'ready',
      projection: { runInput: descriptor, outputs: [] },
    }),
  );
  const read = vi.fn<
    NonNullable<CoordinatorRunStore['readCallableCompletionSource']>
  >(() =>
    Promise.resolve({ kind: 'ready', valueSource: structuredClone(source) }),
  );
  const authorizeSource = vi.fn(() =>
    Promise.resolve({
      snapshot: structuredClone(source.snapshot),
      ...(artifact ? { artifact: { ...metadata, available: true } } : {}),
    }),
  );
  const getStream = vi.fn(() =>
    Promise.resolve({
      metadata,
      body: Readable.from([Buffer.from(bytes)]),
    }),
  );
  const codec = createWorkflowExecutionValueCodec({
    chooseInline: prepareInlineWorkflowExecutionValueV3,
    reserve: vi.fn(),
    writeReserved: vi.fn(),
    authorize: vi.fn(),
    authorizeSource,
    store: { getStream },
  });
  const runStore: CoordinatorRunStore = {
    loadAdvanceState: vi.fn(),
    commitAdvancePlan: vi.fn(),
    acknowledgeAdvanceDelivery: vi.fn(),
    close: vi.fn(),
    loadCallableCompletionSources: load,
    readCallableCompletionSource: read,
  };
  const hydrate = createCoordinatorResultSourceHydration(runStore, {
    policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
    hydrateSource: codec.hydrateSource,
  });
  return { hydrate, load, read, authorizeSource, getStream, source };
}

describe('fresh coordinator precommit source hydration', () => {
  it.each([false, true])(
    'freshly reads original bytes on every invocation (artifact=%s)',
    async (artifact) => {
      const f = fixture(artifact);
      const signal = new AbortController().signal;
      const first = await f.hydrate({ owner, demand, signal });
      const second = await f.hydrate({ owner, demand, signal });
      expect(first).toEqual({ runInput: { answer: 42 }, nodeOutputs: {} });
      expect(second).toEqual(first);
      expect(second?.runInput).not.toBe(first?.runInput);
      expect(f.load).toHaveBeenCalledTimes(2);
      expect(f.read).toHaveBeenCalledTimes(2);
      expect(f.authorizeSource).toHaveBeenCalledTimes(2);
      expect(f.getStream).toHaveBeenCalledTimes(artifact ? 2 : 0);
      for (const [input] of [...f.load.mock.calls, ...f.read.mock.calls]) {
        expect(input.signal).toBe(signal);
        expect(input.owner).toEqual(owner);
        expect(input.owner).not.toBe(owner);
      }
    },
  );

  it('rejects selected-read identity drift before original-byte authorization', async () => {
    const f = fixture(true);
    f.read.mockResolvedValueOnce({
      kind: 'ready',
      valueSource: {
        ...f.source,
        snapshot: { ...f.source.snapshot, sha256: 'b'.repeat(64) },
      },
    });
    await expect(
      f.hydrate({ owner, demand, signal: new AbortController().signal }),
    ).rejects.toThrow('identity does not agree');
    expect(f.authorizeSource).not.toHaveBeenCalled();
    expect(f.getStream).not.toHaveBeenCalled();
  });

  it('joins an in-flight inventory read on abort without starting selected reads', async () => {
    const f = fixture(false);
    const controller = new AbortController();
    const release =
      Promise.withResolvers<
        Awaited<
          ReturnType<
            NonNullable<CoordinatorRunStore['loadCallableCompletionSources']>
          >
        >
      >();
    f.load.mockImplementationOnce(() => release.promise);
    const pending = f.hydrate({ owner, demand, signal: controller.signal });
    controller.abort();
    release.resolve({
      kind: 'ready',
      projection: { runInput: null, outputs: [] },
    });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.authorizeSource).not.toHaveBeenCalled();
  });

  it('preserves a protected-source stop without returning decoded context', async () => {
    const f = fixture(false);
    f.load.mockResolvedValueOnce({
      kind: 'stopped',
      stop: { kind: 'canceled' },
    });
    await expect(
      f.hydrate({ owner, demand, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ stop: { kind: 'canceled' } });
    expect(f.read).not.toHaveBeenCalled();
  });
});
