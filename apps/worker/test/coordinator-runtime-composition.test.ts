import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
  CoordinatorRunStore,
  CoordinatorRunStoreOptions,
  NativeCoordinatorCallDeclarationSource,
  NativeCoordinatorControlDeclarationSource,
} from '@pertexo/database/execution';
import { WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1 } from '@pertexo/database/execution';
import { platformExecutableRegistryHistory } from '@pertexo/node-catalog';
import { buildWorkflowExecutableV3 } from '@pertexo/workflow-engine';
import { JsonataEvaluator } from '@pertexo/workflow-model/expressions';
import { describe, expect, it, vi } from 'vitest';
import {
  createCoordinatorRuntime,
  type CoordinatorCompositionFactories,
} from '../src/execution/coordinator-runtime.js';
import { composeWorkerWorkflowCompatibilityRelease } from '../src/platform/workflow-compatibility.js';
import {
  graph,
  RUN_ID,
  VERSION_ID,
  WORKSPACE_ID,
  WORKFLOW_ID,
} from './support/execution-engine.fixture.js';

const owner = {
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  workflowVersionId: VERSION_ID,
  expectedRevision: 4,
  delivery: { outboxEventId: WORKFLOW_ID, payloadChecksum: 'a'.repeat(64) },
};

/** Capture only the database boundary; all composed native callbacks stay real. */
async function compose(
  overrides: Partial<CoordinatorRunStore> = {},
  evaluator?: JsonataEvaluator,
) {
  let captured: CoordinatorRunStoreOptions | undefined;
  const scanner = {
    claimDueWakeups: vi.fn().mockResolvedValue(0),
    close: vi.fn(),
  };
  const store: CoordinatorRunStore = {
    acknowledgeAdvanceDelivery: vi.fn(),
    commitAdvancePlan: vi.fn(),
    loadAdvanceState: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
  const factories: CoordinatorCompositionFactories = {
    consumer: vi.fn(() => ({
      close: vi.fn(),
      isReady: () => true,
      waitUntilReady: () => Promise.resolve(),
    })),
    deadlineScanner: vi.fn(() => scanner),
    dueScanner: vi.fn(() => scanner),
    notifications: vi.fn(() => ({
      close: vi.fn(),
      publish: vi.fn(),
      resync: vi.fn(),
    })),
    reader: vi.fn(() => ({ close: vi.fn(), readForExecution: vi.fn() })),
    runStore: vi.fn<CoordinatorCompositionFactories['runStore']>(
      (_config, _runtime, options) => {
        captured = options;
        return store;
      },
    ),
    telemetry: vi.fn(),
    traceRunner: vi.fn(),
  };
  const bytes = Buffer.from('{"answer":42}');
  const metadata = {
    workspaceId: WORKSPACE_ID,
    artifactId: WORKFLOW_ID,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
    mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
  } as const;
  const getStream = vi.fn(() =>
    Promise.resolve({ metadata, body: Readable.from([bytes]) }),
  );
  const runtime = await createCoordinatorRuntime(
    {
      database: {
        connectionString: 'postgresql://invalid.invalid/pertexo',
        connectionTimeoutMillis: 100,
        idleTimeoutMillis: 1000,
        max: 1,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      },
      maximumAdmissions: 32,
      redisUrl: 'redis://invalid.invalid:6379/0',
      releaseCohort: 'workflow_call_staging',
      valueWorkPolicy: {
        controlReadTimeoutMillis: 1234,
        controlPollMillis: 100,
        operationTimeoutMillis: 5000,
      },
    },
    {
      engine: { advance: vi.fn() },
      artifactStore: { getStream, checkReadiness: vi.fn() },
      ...(evaluator === undefined ? {} : { expressionEvaluator: evaluator }),
    },
    factories,
  );
  if (captured === undefined)
    throw new Error('Database factory did not capture native contracts');
  return { runtime, options: captured, metadata, getStream };
}

describe('coordinator runtime native database composition', () => {
  it('authenticates a child executable before creating its initial V3 checkpoint', async () => {
    const f = await compose();
    try {
      const nodeRelease = platformExecutableRegistryHistory(
        'workflow_call_staging',
      ).at(-1);
      if (nodeRelease === undefined) throw new Error('Missing staged release');
      const release = composeWorkerWorkflowCompatibilityRelease(nodeRelease);
      const built = buildWorkflowExecutableV3({
        release,
        graph: {
          ...graph(),
          schemaVersion: 2,
          callable: {
            schemaVersion: 1,
            input: { type: 'object', properties: {}, required: [] },
            result: { type: 'object', properties: {}, required: [] },
            resultSelector: { kind: 'literal', value: {} },
          },
        },
      });
      const projection = {
        id: VERSION_ID,
        workspaceId: WORKSPACE_ID,
        workflowId: WORKFLOW_ID,
        versionNumber: 1,
        schemaVersion: 2 as const,
        executableSchemaVersion: 3 as const,
        executableJson: built.envelope,
        checksum: built.checksum,
        compatibilityReleaseEpoch: release.epoch,
      };
      const admit = f.options.workflowCallAdmission?.createInitialCheckpoint;
      if (admit === undefined)
        throw new Error('Missing child admission contract');
      expect(admit(projection, 'test-engine-v1')).toMatchObject({
        schemaVersion: 3,
        engineVersion: 'test-engine-v1',
        workflowVersionId: VERSION_ID,
        nextEventSequence: 2,
        remainingIterationBudget: 1000,
        calls: [],
      });
      expect(() =>
        admit(
          { ...projection, checksum: `wf:v3:sha256:${'f'.repeat(64)}` },
          'test-engine-v1',
        ),
      ).toThrow();
      expect(() =>
        admit(
          { ...projection, compatibilityReleaseEpoch: 999999 },
          'test-engine-v1',
        ),
      ).toThrow('Child executable release is unsupported');
    } finally {
      await f.runtime.close();
    }
  });

  it('forwards fresh call and control reads with owner, signal and bounded read policy, preserving stops', async () => {
    const readCall = vi
      .fn<NonNullable<CoordinatorRunStore['readCoordinatorCallDeclaration']>>()
      .mockResolvedValue({ kind: 'stopped', stop: { kind: 'canceled' } });
    const readControl = vi
      .fn<NonNullable<CoordinatorRunStore['readCoordinatorControlSource']>>()
      .mockResolvedValue({ kind: 'stopped', stop: { kind: 'timed_out' } });
    const f = await compose({
      readCoordinatorCallDeclaration: readCall,
      readCoordinatorControlSource: readControl,
    });
    const signal = new AbortController().signal;
    const call: NativeCoordinatorCallDeclarationSource = {
      invocationKey: 'call',
      nodeId: 'call',
      declarationAttemptId: RUN_ID,
      calleeVersionId: VERSION_ID,
      snapshot: {
        reference: {
          schemaVersion: 1,
          kind: 'artifact',
          artifactId: WORKFLOW_ID,
        },
        sha256: f.metadata.sha256,
        byteLength: f.metadata.byteLength,
      },
    };
    const control: NativeCoordinatorControlDeclarationSource = {
      sequence: 5,
      invocationKey: 'loop',
      nodeId: 'loop',
      attemptId: RUN_ID,
      output: { kind: 'inline', attemptId: RUN_ID },
      controlKind: 'for_each',
      branchPath: [],
      iterationPath: [],
      valueSource: {
        slot: 'upstream_output',
        source: {
          kind: 'physical_output',
          workspaceId: WORKSPACE_ID,
          runId: RUN_ID,
          workflowVersionId: VERSION_ID,
          nodeId: 'loop',
          invocationKey: 'loop',
          attemptId: RUN_ID,
          provenanceId: WORKFLOW_ID,
        },
        valueIdentity: {
          reference: { schemaVersion: 1, kind: 'inline' },
          sha256: f.metadata.sha256,
          byteLength: f.metadata.byteLength,
          mediaType: f.metadata.mediaType,
        },
      },
    };
    try {
      readCall.mockResolvedValue({ kind: 'ready', source: call });
      await expect(
        f.options.hydrateNativeCallDeclaration?.({
          owner,
          source: call,
          signal,
        }),
      ).resolves.toEqual({ answer: 42 });
      readControl.mockResolvedValue({
        kind: 'ready',
        valueSource: {
          slot: 'upstream_output',
          source: control.valueSource.source,
          snapshot: {
            reference: {
              schemaVersion: 1,
              kind: 'inline',
              value: { answer: 42 },
            },
            sha256: f.metadata.sha256,
            byteLength: f.metadata.byteLength,
            serializedValue: '{"answer":42}',
          },
        },
      });
      await expect(
        f.options.hydrateNativeControlSource?.({
          owner,
          source: control,
          signal,
        }),
      ).resolves.toEqual({ answer: 42 });
      expect(f.getStream).toHaveBeenCalledOnce();
      f.getStream.mockClear();
      readCall.mockResolvedValue({
        kind: 'stopped',
        stop: { kind: 'canceled' },
      });
      readControl.mockResolvedValue({
        kind: 'stopped',
        stop: { kind: 'timed_out' },
      });
      await expect(
        f.options.hydrateNativeCallDeclaration?.({
          owner,
          source: call,
          signal,
        }),
      ).rejects.toMatchObject({ stop: { kind: 'canceled' } });
      await expect(
        f.options.hydrateNativeControlSource?.({
          owner,
          source: control,
          signal,
        }),
      ).rejects.toMatchObject({ stop: { kind: 'timed_out' } });
      expect(readCall).toHaveBeenCalledWith({
        owner,
        source: call,
        signal,
        readTimeoutMillis: 1234,
      });
      expect(readControl).toHaveBeenCalledWith({
        owner,
        source: control,
        signal,
        readTimeoutMillis: 1234,
      });
      expect(f.getStream).not.toHaveBeenCalled();
    } finally {
      await f.runtime.close();
    }
  });

  it('composes fresh result sources, inline result preparation and the borrowed evaluator without taking its cleanup ownership', async () => {
    const evaluator = new JsonataEvaluator();
    const shutdown = vi.spyOn(evaluator, 'shutdown');
    const load = vi
      .fn<NonNullable<CoordinatorRunStore['loadCallableCompletionSources']>>()
      .mockResolvedValue({ kind: 'stopped', stop: { kind: 'canceled' } });
    const read =
      vi.fn<NonNullable<CoordinatorRunStore['readCallableCompletionSource']>>();
    const f = await compose(
      {
        loadCallableCompletionSources: load,
        readCallableCompletionSource: read,
        inspectCoordinatorValueReadOwner: vi.fn(),
      },
      evaluator,
    );
    const signal = new AbortController().signal;
    try {
      await expect(
        f.options.hydrateNativeResultSources?.({
          owner,
          demand: {
            expectedRevision: 4,
            resultSelector: { kind: 'run_input', path: '$' },
            requiresRunInput: true,
            sources: [],
          },
          signal,
        }),
      ).rejects.toMatchObject({ stop: { kind: 'canceled' } });
      expect(load).toHaveBeenCalledWith(
        expect.objectContaining({ owner, signal, readTimeoutMillis: 1234 }),
      );
      const sourceIdentity = {
        kind: 'run_input' as const,
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        workflowVersionId: VERSION_ID,
        provenanceId: WORKFLOW_ID,
      };
      load.mockResolvedValue({
        kind: 'ready',
        projection: {
          runInput: {
            slot: 'run_input',
            source: sourceIdentity,
            valueIdentity: {
              reference: { schemaVersion: 1, kind: 'inline' },
              sha256: f.metadata.sha256,
              byteLength: f.metadata.byteLength,
              mediaType: f.metadata.mediaType,
            },
          },
          outputs: [],
        },
      });
      read.mockResolvedValue({
        kind: 'ready',
        valueSource: {
          slot: 'run_input',
          source: sourceIdentity,
          snapshot: {
            reference: {
              schemaVersion: 1,
              kind: 'inline',
              value: { answer: 42 },
            },
            serializedValue: '{"answer":42}',
            sha256: f.metadata.sha256,
            byteLength: f.metadata.byteLength,
          },
        },
      });
      await expect(
        f.options.hydrateNativeResultSources?.({
          owner,
          demand: {
            expectedRevision: 4,
            resultSelector: { kind: 'run_input', path: '$' },
            requiresRunInput: true,
            sources: [],
          },
          signal,
        }),
      ).resolves.toEqual({ runInput: { answer: 42 }, nodeOutputs: {} });
      expect(read).toHaveBeenCalledWith(
        expect.objectContaining({ owner, signal, readTimeoutMillis: 1234 }),
      );
      await expect(
        f.options.prepareNativeResultValue?.({
          owner: {
            kind: 'run_result',
            ...owner,
            resultRevision: 5,
            resultIdentity: 'b'.repeat(64),
          },
          value: { answer: 42 },
          signal,
        }),
      ).resolves.toMatchObject({
        reference: { schemaVersion: 1, kind: 'inline', value: { answer: 42 } },
      });
      await expect(
        f.options.callableResultEvaluator?.evaluate({
          expression: '6 * 7',
          policyVersion: 1,
          context: { runInput: null, nodeOutputs: {} },
          signal,
        }),
      ).resolves.toMatchObject({ value: 42 });
    } finally {
      await f.runtime.close();
      expect(shutdown).not.toHaveBeenCalled();
      await evaluator.shutdown();
    }
  });
});
