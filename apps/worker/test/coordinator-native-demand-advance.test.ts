import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import type {
  CoordinatorRunStore,
  NativeCallableValueDescriptor,
  NativeNodeAttemptValueSource,
} from '@pertexo/database/execution';
import {
  prepareInlineWorkflowExecutionValueV3,
  serializeWorkflowExecutionJsonValueV3,
  WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
} from '@pertexo/database/execution';
import { CORE_REGISTRY_RELEASE } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutableV3,
  composeExecutableCompatibilityReleaseV3,
  createWorkflowCheckpointV3,
  invocationKey,
} from '@pertexo/workflow-engine';
import { JsonataEvaluator } from '@pertexo/workflow-model/expressions';
import type { ValueSource } from '@pertexo/workflow-model/graph-contract';
import type { CallableObjectTypeDescriptorV1 } from '@pertexo/workflow-model/callable-type-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoordinatorAdvanceEngine } from '../src/execution/coordinator-engine.js';
import { advanceNativeCoordinator } from '../src/execution/coordinator-native-demand-advance.js';
import { COORDINATOR_VALUE_WORK_POLICY_DEFAULTS } from '../src/execution/coordinator-value-work-lifetime.js';
import { createWorkflowExecutionValueCodec } from '../src/execution/workflow-execution-value-codec.js';
import {
  RUN_ID,
  VERSION_ID,
  WORKFLOW_ID,
  WORKSPACE_ID,
  graph,
} from './support/execution-engine.fixture.js';

function fixture(
  values: readonly { payload: string }[],
  originals?: readonly string[],
  selector?: ValueSource,
) {
  const keys = values.map((_value, index) => `n${String(index)}`);
  const release = composeExecutableCompatibilityReleaseV3(
    CORE_REGISTRY_RELEASE,
  );
  const resultType: CallableObjectTypeDescriptorV1 =
    selector?.kind === 'node_output'
      ? {
          type: 'object',
          properties: { payload: { type: 'string' } },
          required: ['payload'],
        }
      : {
          type: 'object',
          properties: { count: { type: 'integer' } },
          required: ['count'],
        };
  const executable = buildWorkflowExecutableV3({
    release,
    graph: {
      schemaVersion: 2,
      settings: {},
      edges: [],
      nodes: keys.map((id) => ({ ...graph().nodes[0], id })),
      callable: {
        schemaVersion: 1,
        input: { type: 'object', properties: {}, required: [] },
        result: resultType,
        resultSelector: selector ?? {
          kind: 'expression',
          language: 'jsonata',
          policyVersion: 1,
          expression: '{"count":$count(nodeOutputs.*)}',
        },
      },
    },
  });
  const sources = values.map((value, index) => {
    const key = keys[index];
    if (key === undefined) throw new Error('Node fixture key is missing');
    const id = `66666666-6666-4666-8666-${String(index + 1).padStart(12, '0')}`;
    const bytes = Buffer.from(
      originals?.[index] ?? serializeWorkflowExecutionJsonValueV3(value),
    );
    const metadata = {
      artifactId: id,
      workspaceId: WORKSPACE_ID,
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
    } as const;
    const reference = prepareInlineWorkflowExecutionValueV3(value) ?? {
      schemaVersion: 1 as const,
      kind: 'artifact' as const,
      artifactId: id,
    };
    const source: Extract<
      NativeNodeAttemptValueSource,
      { slot: 'upstream_output' }
    > = {
      slot: 'upstream_output',
      source: {
        kind: 'physical_output',
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        workflowVersionId: VERSION_ID,
        provenanceId: id,
        attemptId: id,
        nodeId: key,
        invocationKey: invocationKey({
          workflowVersionId: VERSION_ID,
          nodeId: key,
        }),
      },
      snapshot: {
        reference,
        sha256: metadata.sha256,
        byteLength: bytes.byteLength,
        ...(reference.kind === 'inline'
          ? { serializedValue: bytes.toString('utf8') }
          : {}),
      },
    };
    const descriptor: Extract<
      NativeCallableValueDescriptor,
      { slot: 'upstream_output' }
    > = {
      slot: 'upstream_output',
      source: source.source,
      valueIdentity: {
        reference:
          reference.kind === 'inline'
            ? { schemaVersion: 1, kind: 'inline' }
            : reference,
        sha256: metadata.sha256,
        byteLength: bytes.byteLength,
        mediaType: metadata.mediaType,
      },
    };
    return {
      bytes,
      metadata,
      source,
      descriptor,
      output:
        reference.kind === 'inline'
          ? { kind: 'inline' as const, attemptId: id }
          : { kind: 'artifact' as const, artifactId: id },
    };
  });
  const current = {
    ...createWorkflowCheckpointV3({
      engineVersion: 'phase3-engine-v1',
      workflowVersionId: VERSION_ID,
      iterationBudget: 0,
    }),
    runStatus: 'running',
    admittedInvocationKeys: sources.map(
      ({ source }) => source.source.invocationKey,
    ),
    invocations: sources.map(({ source }) => ({
      invocationKey: source.source.invocationKey,
      nodeId: source.source.nodeId,
      attemptNumber: 1,
      status: 'running',
    })),
  };
  const readSource = vi.fn<
    NonNullable<CoordinatorRunStore['readCallableCompletionSource']>
  >(({ source }) => {
    const selected = sources.find(
      (item) => item.source.source.provenanceId === source.source.provenanceId,
    );
    if (!selected) throw new Error('Unknown fixture source');
    return Promise.resolve({
      kind: 'ready',
      valueSource: structuredClone(selected.source),
    });
  });
  const getStream = vi.fn(({ artifactId }: { artifactId: string }) => {
    const selected = sources.find(
      ({ metadata }) => metadata.artifactId === artifactId,
    );
    if (!selected) throw new Error('Unknown fixture artifact');
    return Promise.resolve({
      body: Readable.from([Buffer.from(selected.bytes)]),
      metadata: { ...selected.metadata },
    });
  });
  const codec = createWorkflowExecutionValueCodec({
    chooseInline: prepareInlineWorkflowExecutionValueV3,
    reserve: vi.fn(),
    writeReserved: vi.fn(),
    authorize: vi.fn(),
    authorizeSource: ({ source }) => {
      const selected = sources.find(
        (item) =>
          item.source.source.provenanceId === source.source.provenanceId,
      );
      if (!selected) throw new Error('Unknown fixture accepted source');
      return Promise.resolve({
        snapshot: structuredClone(selected.source.snapshot),
        ...(selected.source.snapshot.reference.kind === 'artifact'
          ? { artifact: { ...selected.metadata, available: true } }
          : {}),
      });
    },
    store: { getStream },
  });
  const inspectOwner = vi.fn<
    NonNullable<CoordinatorRunStore['inspectCoordinatorValueReadOwner']>
  >(() =>
    Promise.resolve({
      kind: 'active',
      databaseNow: '2026-10-04T00:00:00.000Z',
      deadlineAt: null,
    }),
  );
  const selectedSources =
    selector?.kind === 'node_output'
      ? sources.filter(({ source }) => source.source.nodeId === selector.nodeId)
      : sources;
  const loadSources = vi.fn<
    NonNullable<CoordinatorRunStore['loadCallableCompletionSources']>
  >(() =>
    Promise.resolve({
      kind: 'ready',
      projection: {
        runInput: null,
        outputs: selectedSources.map(({ descriptor, output }) => ({
          invocationKey: descriptor.source.invocationKey,
          output,
          valueSource: descriptor,
        })),
      },
    }),
  );
  const runStore: CoordinatorRunStore = {
    loadAdvanceState: vi.fn(),
    commitAdvancePlan: vi.fn(),
    acknowledgeAdvanceDelivery: vi.fn(),
    close: vi.fn(),
    inspectCoordinatorValueReadOwner: inspectOwner,
    loadCallableCompletionSources: loadSources,
    readCallableCompletionSource: readSource,
  };
  const evaluator = new JsonataEvaluator({ maxActive: 1 });
  const input = {
    engine: createCoordinatorAdvanceEngine({
      admissionRelease: release,
      expressionEvaluator: evaluator,
    }),
    workspaceId: WORKSPACE_ID,
    delivery: { outboxEventId: WORKFLOW_ID, payloadChecksum: 'a'.repeat(64) },
    runStore,
    valueWork: {
      policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
      hydrateSource: codec.hydrateSource,
    },
    advance: {
      runId: RUN_ID,
      workflowVersionId: VERSION_ID,
      projection: {
        id: VERSION_ID,
        workspaceId: WORKSPACE_ID,
        workflowId: WORKFLOW_ID,
        versionNumber: 1,
        schemaVersion: 2 as const,
        executableSchemaVersion: 3 as const,
        executableJson: executable.envelope,
        checksum: executable.checksum,
        compatibilityReleaseEpoch: release.epoch,
      },
      checkpoint: current,
      observations: sources.map(({ source, output }, index) => ({
        kind: 'outcome',
        sequence: current.nextEventSequence + index,
        occurredAt: '2026-10-04T00:00:00.000Z',
        invocationKey: source.source.invocationKey,
        attemptId:
          source.source.kind === 'physical_output'
            ? source.source.attemptId
            : '',
        attemptNumber: 1,
        status: 'succeeded',
        output,
      })),
      occurredAt: '2026-10-04T00:00:00.000Z',
      maximumAdmissions: 1,
      signal: new AbortController().signal,
    },
  };
  const firstSource = sources[0];
  if (firstSource === undefined) throw new Error('Fixture requires one source');
  return {
    input,
    readSource,
    getStream,
    evaluator,
    sources,
    inspectOwner,
    loadSources,
    release,
    firstSource,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('operative native coordinator demand composition with ordinary owner adapters', () => {
  it('fetches only the declared direct node selector, not unrelated completed roots', async () => {
    const selected = fixture(
      Array.from({ length: 3 }, () => ({ payload: 'tiny' })),
      undefined,
      { kind: 'node_output', nodeId: 'n0', path: '$' },
    );
    try {
      await expect(
        advanceNativeCoordinator(selected.input),
      ).resolves.toMatchObject({
        kind: 'transition',
        plan: {
          callableResult: { kind: 'succeeded', value: { payload: 'tiny' } },
        },
      });
      expect(selected.readSource).toHaveBeenCalledOnce();
      expect(
        selected.readSource.mock.calls[0]?.[0].source.source,
      ).toMatchObject({ nodeId: 'n0' });
      expect(selected.evaluator.diagnostics().workerCreations).toBe(0);
    } finally {
      await selected.evaluator.shutdown();
    }
  });
  it('keeps the actual engine evaluator inside the demand watcher and joins its isolated worker before returning the owner stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const selected = fixture([{ payload: 'tiny' }]);
    const workerStarted = Promise.withResolvers<undefined>();
    const terminationStarted = Promise.withResolvers<undefined>();
    const releaseTermination = Promise.withResolvers<undefined>();
    let stopped = false;
    let finished = false;
    let worker: Worker | undefined;
    const context = new AbortController();
    const evaluator = new JsonataEvaluator({
      maxActive: 1,
      workerFactory: (_url, options) => {
        worker = new Worker(
          "require('node:worker_threads').parentPort.on('message', () => {});",
          { ...options, eval: true },
        );
        const terminate = worker.terminate.bind(worker);
        worker.terminate = async () => {
          terminationStarted.resolve(undefined);
          await releaseTermination.promise;
          return terminate();
        };
        workerStarted.resolve(undefined);
        return worker;
      },
    });
    selected.input.engine = createCoordinatorAdvanceEngine({
      admissionRelease: selected.release,
      expressionEvaluator: evaluator,
    });
    selected.input.advance.signal = context.signal;
    selected.inspectOwner.mockImplementation(() =>
      Promise.resolve(
        stopped
          ? { kind: 'stopped', stop: { kind: 'canceled' } }
          : {
              kind: 'active',
              databaseNow: '2026-10-04T00:00:00.000Z',
              deadlineAt: null,
            },
      ),
    );
    const result = advanceNativeCoordinator(selected.input);
    void result.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    try {
      await Promise.race([workerStarted.promise, result]);
      expect(worker).toBeInstanceOf(Worker);
      expect(selected.readSource).toHaveBeenCalledOnce();
      stopped = true;
      await vi.advanceTimersByTimeAsync(250);
      await terminationStarted.promise;
      expect(finished).toBe(false);
      releaseTermination.resolve(undefined);
      await expect(result).resolves.toEqual({
        kind: 'value_work_stopped',
        stop: { kind: 'canceled' },
      });
      expect(worker?.threadId).toBe(-1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      releaseTermination.resolve(undefined);
      context.abort();
      await result.catch(() => undefined);
      await evaluator.shutdown();
      await selected.evaluator.shutdown();
    }
  });
  it('discards an evaluated success plan when the final owner check is stale before the next polling interval', async () => {
    const selected = fixture([{ payload: 'tiny' }]);
    const engine = selected.input.engine;
    let computed = false;
    selected.inspectOwner.mockImplementation(() =>
      Promise.resolve(
        computed
          ? { kind: 'stopped', stop: { kind: 'stale', revision: 1 } }
          : {
              kind: 'active',
              databaseNow: '2026-10-04T00:00:00.000Z',
              deadlineAt: null,
            },
      ),
    );
    selected.input.engine = {
      advance: async (input) => {
        const result = await engine.advance(input);
        expect(result).toMatchObject({
          kind: 'transition',
          plan: { callableResult: { kind: 'succeeded', value: { count: 1 } } },
        });
        computed = true;
        return result;
      },
    };
    try {
      await expect(advanceNativeCoordinator(selected.input)).resolves.toEqual({
        kind: 'value_work_stopped',
        stop: { kind: 'stale', revision: 1 },
      });
      expect(selected.evaluator.diagnostics().workerCreations).toBe(1);
    } finally {
      await selected.evaluator.shutdown();
    }
  });
  it.each([
    'inspectCoordinatorValueReadOwner',
    'loadCallableCompletionSources',
    'readCallableCompletionSource',
    'codec',
  ] as const)(
    'fails closed before source I/O when %s is missing',
    async (missing) => {
      const selected = fixture([{ payload: 'tiny' }]);
      const runStore = { ...selected.input.runStore };
      if (missing === 'inspectCoordinatorValueReadOwner')
        delete runStore.inspectCoordinatorValueReadOwner;
      else if (missing === 'loadCallableCompletionSources')
        delete runStore.loadCallableCompletionSources;
      else if (missing === 'readCallableCompletionSource')
        delete runStore.readCallableCompletionSource;
      try {
        await expect(
          advanceNativeCoordinator({
            ...selected.input,
            runStore,
            valueWork:
              missing === 'codec'
                ? { policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS }
                : selected.input.valueWork,
          }),
        ).resolves.toEqual({
          kind: 'value_work_stopped',
          stop: {
            kind: 'unavailable',
            reason:
              missing === 'inspectCoordinatorValueReadOwner'
                ? 'control_read_failed'
                : 'source_read_failed',
          },
        });
        expect(selected.loadSources).not.toHaveBeenCalled();
        expect(selected.readSource).not.toHaveBeenCalled();
        expect(selected.getStream).not.toHaveBeenCalled();
      } finally {
        await selected.evaluator.shutdown();
      }
    },
  );
  it.each(['snapshot', 'value', 'serializedValue', 'locator'])(
    'rejects %s payload in a metadata-only inventory before a snapshot fetch',
    async (key) => {
      const selected = fixture([{ payload: 'tiny' }]);
      const source = selected.firstSource;
      selected.loadSources.mockResolvedValue({
        kind: 'ready',
        projection: {
          runInput: null,
          outputs: [
            {
              invocationKey: source.descriptor.source.invocationKey,
              output: source.output,
              valueSource: Object.assign({}, source.descriptor, {
                [key]: source.source.snapshot,
              }),
            },
          ],
        },
      });
      try {
        await expect(
          advanceNativeCoordinator(selected.input),
        ).rejects.toMatchObject({ name: 'ZodError' });
        expect(selected.readSource).not.toHaveBeenCalled();
        expect(selected.getStream).not.toHaveBeenCalled();
      } finally {
        await selected.evaluator.shutdown();
      }
    },
  );
  it('rejects changed fetched byte identity before codec authorization or object reads', async () => {
    const selected = fixture([{ payload: 'x'.repeat(600_000) }]);
    const source = selected.firstSource.source;
    selected.readSource.mockResolvedValue({
      kind: 'ready',
      valueSource: {
        ...source,
        snapshot: { ...source.snapshot, sha256: 'b'.repeat(64) },
      },
    });
    try {
      await expect(advanceNativeCoordinator(selected.input)).rejects.toThrow(
        'Coordinator fetched source identity does not agree',
      );
      expect(selected.readSource).toHaveBeenCalledOnce();
      expect(selected.getStream).not.toHaveBeenCalled();
    } finally {
      await selected.evaluator.shutdown();
    }
  });
  it('does no owner/source inspection for literal completion or a non-success advance', async () => {
    const literal = fixture([{ payload: 'tiny' }], undefined, {
      kind: 'literal',
      value: { count: 0 },
    });
    const pending = fixture([{ payload: 'tiny' }]);
    pending.input.advance.observations = [];
    try {
      await expect(
        advanceNativeCoordinator(literal.input),
      ).resolves.toMatchObject({
        kind: 'transition',
        plan: { callableResult: { kind: 'succeeded', value: { count: 0 } } },
      });
      await expect(advanceNativeCoordinator(pending.input)).resolves.toEqual({
        kind: 'no_change',
        revision: 0,
      });
      for (const selected of [literal, pending]) {
        expect(selected.inspectOwner).not.toHaveBeenCalled();
        expect(selected.loadSources).not.toHaveBeenCalled();
        expect(selected.readSource).not.toHaveBeenCalled();
      }
    } finally {
      await literal.evaluator.shutdown();
      await pending.evaluator.shutdown();
    }
  });
  it('joins a canceled protected snapshot fetch and never fetches or hydrates the next source', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const selected = fixture(
      Array.from({ length: 3 }, () => ({ payload: 'x'.repeat(600_000) })),
    );
    const context = new AbortController();
    const started = Promise.withResolvers<undefined>();
    const canceled = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let cancelOwner = false;
    let finished = false;
    selected.input.advance.signal = context.signal;
    selected.input.runStore.inspectCoordinatorValueReadOwner = () =>
      Promise.resolve(
        cancelOwner
          ? { kind: 'stopped', stop: { kind: 'canceled' } }
          : {
              kind: 'active',
              databaseNow: '2026-10-04T00:00:00.000Z',
              deadlineAt: null,
            },
      );
    selected.readSource.mockImplementation(async ({ signal }) => {
      signal.addEventListener(
        'abort',
        () => {
          canceled.resolve(undefined);
        },
        { once: true },
      );
      started.resolve(undefined);
      await release.promise;
      return {
        kind: 'ready',
        valueSource: structuredClone(selected.firstSource.source),
      };
    });
    const result = advanceNativeCoordinator(selected.input);
    void result.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    try {
      await Promise.race([started.promise, result]);
      expect(selected.readSource).toHaveBeenCalledOnce();
      cancelOwner = true;
      await vi.advanceTimersByTimeAsync(250);
      await canceled.promise;
      expect(finished).toBe(false);
      release.resolve(undefined);
      await expect(result).resolves.toEqual({
        kind: 'value_work_stopped',
        stop: { kind: 'canceled' },
      });
      expect(selected.readSource).toHaveBeenCalledOnce();
      expect(selected.getStream).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release.resolve(undefined);
      context.abort();
      await result.catch(() => undefined);
      await selected.evaluator.shutdown();
    }
  });
  it('fetches six whitespace-heavy original inline snapshots without an aggregate-original-byte cap and evaluates the eligible decoded context', async () => {
    const values = Array.from({ length: 6 }, () => ({ payload: 'tiny' }));
    const originals = values.map(
      (value) => ' '.repeat(240_000) + JSON.stringify(value),
    );
    const selected = fixture(values, originals);
    try {
      const result = await advanceNativeCoordinator(selected.input);
      expect(result).toMatchObject({
        kind: 'transition',
        plan: {
          checkpoint: { runStatus: 'succeeded' },
          callableResult: { value: { count: 6 } },
        },
      });
      expect(selected.readSource).toHaveBeenCalledTimes(6);
      expect(selected.getStream).not.toHaveBeenCalled();
      expect(selected.evaluator.diagnostics().workerCreations).toBe(1);
      expect(
        selected.sources.map(({ source }) => source.snapshot.serializedValue),
      ).toEqual(originals);
    } finally {
      await selected.evaluator.shutdown();
    }
  });
  it('fetches only two protected snapshots when their decoded context exceeds the bound, before a third fetch', async () => {
    const selected = fixture(
      Array.from({ length: 3 }, () => ({ payload: 'x'.repeat(600_000) })),
    );
    try {
      const result = await advanceNativeCoordinator(selected.input);
      expect(result).toMatchObject({
        kind: 'transition',
        plan: { checkpoint: { runStatus: 'failed' } },
      });
      expect(selected.readSource).toHaveBeenCalledTimes(2);
      expect(selected.getStream).toHaveBeenCalledTimes(2);
      expect(selected.evaluator.diagnostics().workerCreations).toBe(0);
    } finally {
      await selected.evaluator.shutdown();
    }
  });
});
