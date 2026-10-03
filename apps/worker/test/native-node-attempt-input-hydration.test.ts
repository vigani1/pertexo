import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type {
  NodeAttemptInputs,
  NativeNodeAttemptValueSource,
  NativeNodeAttemptValueSources,
} from '@pertexo/database/execution';

import { hydrateNativeNodeAttemptInputs } from '../src/execution/native-node-attempt-input-hydration.js';
import { createWorkflowExecutionValueCodec } from '../src/execution/workflow-execution-value-codec.js';
import { createWorkflowExecutionValueRuntime } from '../src/execution/workflow-execution-value-runtime.js';
import { createNodeAttemptHandler } from '../src/execution/node-attempt-handler.js';
import {
  lease,
  delivery,
  executionStore,
  executionHandler,
  projection,
  registryPreparedAttempt,
} from './support/node-attempt-handler.fixture.js';

const current = lease();
const source: Extract<NativeNodeAttemptValueSource, { slot: 'run_input' }> = {
  slot: 'run_input',
  source: {
    kind: 'run_input',
    workspaceId: current.workspaceId,
    runId: current.runId,
    workflowVersionId: current.workflowVersionId,
    provenanceId: '99999999-9999-4999-8999-999999999999',
  },
  snapshot: {
    reference: { schemaVersion: 1, kind: 'inline', value: null },
    sha256: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
    byteLength: 4,
    serializedValue: 'null',
  },
};

describe('explicit native attempt input hydration', () => {
  it.each(['execute', 'wait_resume'] as const)(
    'preserves retained v2 %s without native source descriptors',
    async (admissionKind) => {
      const complete = vi.fn(() =>
        Promise.resolve({
          kind: 'committed' as const,
          outboxEventId: current.delivery.outboxEventId,
        }),
      );
      const runStore = executionStore({
        claimDelivery: () =>
          Promise.resolve({
            kind: 'claimed',
            lease: { ...current, admissionKind },
          }),
        loadInputs: () =>
          Promise.resolve({
            abortRequested: false,
            runInput: null,
            completedNodeOutputs: [],
            resumeOutput: { retained: true },
          }),
        complete,
      });
      await expect(
        executionHandler(runStore).handle(delivery(), {
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ kind: 'committed' });
      expect(complete).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: {
            status: 'succeeded',
            output: admissionKind === 'wait_resume' ? { retained: true } : null,
          },
        }),
      );
    },
  );
  it.each(['execute', 'retry', 'wait_resume'] as const)(
    'refuses native %s without its explicit source projection before any dispatch, completion or source read',
    async (admissionKind) => {
      const execute = vi.fn(() =>
        Promise.resolve({ kind: 'succeeded' as const, output: null }),
      );
      const hydrateSource = vi.fn(() => Promise.resolve(null));
      const complete = vi.fn(() =>
        Promise.resolve({
          kind: 'committed' as const,
          outboxEventId: current.delivery.outboxEventId,
        }),
      );
      const handler = createNodeAttemptHandler({
        workerId: 'worker-1',
        heartbeatIntervalMillis: 1_000,
        leaseDurationSeconds: 30,
        reader: {
          close: () => Promise.resolve(),
          readForExecution: () =>
            Promise.resolve({
              kind: 'v3_projection',
              workflowVersion: {
                ...projection(),
                schemaVersion: 2,
                executableSchemaVersion: 3,
                checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
              },
            }),
        },
        runStore: executionStore({
          claimDelivery: () =>
            Promise.resolve({
              kind: 'claimed',
              lease: { ...current, admissionKind },
            }),
          loadInputs: () =>
            Promise.resolve({
              runInput: null,
              completedNodeOutputs: [],
              resumeOutput: { untrusted: true },
              abortRequested: false,
            }),
          complete,
        }),
        registry: { execute },
        nativeInputValues: { hydrateSource },
        engine: { prepare: () => registryPreparedAttempt() },
      });
      await expect(
        handler.handle(delivery(), { signal: new AbortController().signal }),
      ).rejects.toThrow('Native input source projection is unavailable');
      expect(execute).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(hydrateSource).not.toHaveBeenCalled();
    },
  );
  it('refuses native input loading and hydration after an initial control refusal', async () => {
    let completion: unknown;
    const handler = createNodeAttemptHandler({
      workerId: 'worker-1',
      heartbeatIntervalMillis: 10,
      leaseDurationSeconds: 30,
      reader: {
        close: () => Promise.resolve(),
        readForExecution: () =>
          Promise.resolve({
            kind: 'v3_projection',
            workflowVersion: {
              ...projection(),
              schemaVersion: 2,
              executableSchemaVersion: 3,
              checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
            },
          }),
      },
      runStore: executionStore({
        heartbeat: () =>
          Promise.resolve({
            abortRequested: true,
            abortReason: 'canceled',
            leaseExpiresAt: current.leaseExpiresAt,
          }),
        loadInputs: () =>
          Promise.reject(new Error('Refused native input load is forbidden')),
        complete: (input) => {
          completion = input.outcome;
          return Promise.resolve({
            kind: 'committed',
            outboxEventId: current.delivery.outboxEventId,
          });
        },
      }),
      registry: {
        execute: () =>
          Promise.reject(new Error('Refused execution is forbidden')),
      },
      nativeInputValues: {
        hydrateSource: () =>
          Promise.reject(new Error('Refused hydration is forbidden')),
      },
      engine: { prepare: () => registryPreparedAttempt() },
    });
    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(completion).toEqual({
      status: 'canceled',
      safeErrorCode: 'execution.canceled',
    });
  });
  it.each([
    { available: false },
    { artifactId: '77777777-7777-4777-8777-777777777777' },
    { byteLength: 5 },
    { sha256: 'a'.repeat(64) },
  ])(
    'rejects incompatible accepted artifact metadata before object IO %j',
    async (patch) => {
      const artifactId = '88888888-8888-4888-8888-888888888888';
      const artifactSource = {
        ...source,
        snapshot: {
          reference: {
            schemaVersion: 1 as const,
            kind: 'artifact' as const,
            artifactId,
          },
          byteLength: 4,
          sha256: source.snapshot.sha256,
        },
      };
      let reads = 0;
      const codec = createWorkflowExecutionValueCodec({
        chooseInline: () => undefined,
        reserve: () => Promise.reject(new Error('Preparation is forbidden')),
        writeReserved: () =>
          Promise.reject(new Error('Preparation is forbidden')),
        authorize: () =>
          Promise.reject(new Error('Legacy authorization is forbidden')),
        authorizeSource: () =>
          Promise.resolve({
            snapshot: artifactSource.snapshot,
            artifact: {
              artifactId,
              workspaceId: current.workspaceId,
              byteLength: 4,
              sha256: source.snapshot.sha256,
              mediaType:
                'application/vnd.pertexo.execution-value+json;version=1',
              available: true,
              ...patch,
            },
          }),
        store: {
          getStream: () => {
            reads++;
            return Promise.reject(new Error('Object read is forbidden'));
          },
        },
      });
      await expect(
        codec.hydrateSource({
          owner: { kind: 'attempt', lease: current },
          source: artifactSource,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(reads).toBe(0);
    },
  );
  it('rejects a missing requested upstream descriptor before reading other sources', async () => {
    await expect(
      hydrateNativeNodeAttemptInputs({
        lease: current,
        inputs: {
          runInput: null,
          completedNodeOutputs: [],
          abortRequested: false,
          nativeValueSources: { runInput: source, completedNodeOutputs: [] },
        },
        expectedUpstreamNodeOutputs: [
          { nodeId: 'missing', invocationKey: 'missing' },
        ],
        signal: new AbortController().signal,
        hydrate: () => Promise.reject(new Error('Source read must not start')),
      }),
    ).rejects.toThrow(
      'Native upstream value source is missing or out of scope',
    );
  });
  it('hydrates upstream values sequentially in the protected scope order', async () => {
    const first: Extract<
      NativeNodeAttemptValueSource,
      { slot: 'upstream_output' }
    > = {
      slot: 'upstream_output',
      snapshot: source.snapshot,
      source: {
        ...source.source,
        kind: 'physical_output',
        attemptId: current.attemptId,
        nodeId: 'first',
        invocationKey: 'first-scope',
      },
    };
    const second = {
      ...first,
      source: {
        ...first.source,
        nodeId: 'second',
        invocationKey: 'second-scope',
      },
    };
    let active = 0;
    let maximumActive = 0;
    const hydrated = await hydrateNativeNodeAttemptInputs({
      lease: current,
      inputs: {
        runInput: null,
        completedNodeOutputs: [],
        abortRequested: false,
        nativeValueSources: {
          runInput: null,
          completedNodeOutputs: [second, first],
        },
      },
      expectedUpstreamNodeOutputs: [
        { nodeId: 'second', invocationKey: 'second-scope' },
        { nodeId: 'first', invocationKey: 'first-scope' },
      ],
      signal: new AbortController().signal,
      hydrate: async (input) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active--;
        return input.source.slot === 'upstream_output'
          ? input.source.source.nodeId
          : null;
      },
    });
    expect(hydrated.completedNodeOutputs).toEqual([
      { nodeId: 'second', invocationKey: 'second-scope', value: 'second' },
      { nodeId: 'first', invocationKey: 'first-scope', value: 'first' },
    ]);
    expect(maximumActive).toBe(1);
  });
  it('rejects a missing native run-input descriptor before accepting even a null inline value', async () => {
    await expect(
      hydrateNativeNodeAttemptInputs({
        lease: current,
        inputs: {
          runInput: null,
          completedNodeOutputs: [],
          abortRequested: false,
          nativeValueSources: {
            completedNodeOutputs: [],
          } as unknown as NativeNodeAttemptValueSources,
        },
        signal: new AbortController().signal,
        hydrate: () => Promise.resolve(null),
      }),
    ).rejects.toThrow('Native run input value source is missing');
  });
  it('hydrates native Wait resume under the consuming lease without executing or reserving again', async () => {
    const resumedLease = { ...current, admissionKind: 'wait_resume' as const };
    const resumeSource: Extract<
      NativeNodeAttemptValueSource,
      { slot: 'wait_resume_output' }
    > = {
      slot: 'wait_resume_output',
      snapshot: source.snapshot,
      source: {
        ...source.source,
        kind: 'physical_output',
        nodeId: current.nodeId,
        invocationKey: current.invocationKey,
        attemptId: '88888888-8888-4888-8888-888888888888',
      },
    };
    let completion: unknown;
    const contextSignal = new AbortController().signal;
    const handler = createNodeAttemptHandler({
      workerId: 'worker-1',
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader: {
        close: () => Promise.resolve(),
        readForExecution: () =>
          Promise.resolve({
            kind: 'v3_projection',
            workflowVersion: {
              ...projection(),
              schemaVersion: 2,
              executableSchemaVersion: 3,
              checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
            },
          }),
      },
      runStore: executionStore({
        claimDelivery: () =>
          Promise.resolve({ kind: 'claimed', lease: resumedLease }),
        loadInputs: () =>
          Promise.resolve({
            runInput: null,
            completedNodeOutputs: [],
            abortRequested: false,
            nativeValueSources: {
              runInput: null,
              completedNodeOutputs: [],
              resumeOutput: resumeSource,
            },
          }),
        complete: (input) => {
          completion = input.outcome;
          return Promise.resolve({
            kind: 'committed',
            outboxEventId: current.delivery.outboxEventId,
          });
        },
      }),
      registry: {
        execute: () =>
          Promise.reject(new Error('Wait resume execution is forbidden')),
      },
      nativeInputValues: {
        hydrateSource: (input) => {
          expect(input.owner).toEqual({ kind: 'attempt', lease: resumedLease });
          expect(input.source).toBe(resumeSource);
          expect(input.signal).not.toBe(contextSignal);
          return Promise.resolve({ resumed: true });
        },
      },
      engine: { prepare: () => registryPreparedAttempt() },
    });
    await expect(
      handler.handle(delivery(), { signal: contextSignal }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(completion).toEqual({
      status: 'succeeded',
      output: { resumed: true },
    });
  });
  it('settles durable heartbeat cancellation during native hydration without executing a node', async () => {
    let completion: unknown;
    let heartbeats = 0;
    let hydrationStarted = false;
    const handler = createNodeAttemptHandler({
      workerId: 'worker-1',
      heartbeatIntervalMillis: 10,
      leaseDurationSeconds: 30,
      reader: {
        close: () => Promise.resolve(),
        readForExecution: () =>
          Promise.resolve({
            kind: 'v3_projection',
            workflowVersion: {
              ...projection(),
              schemaVersion: 2,
              executableSchemaVersion: 3,
              checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
            },
          }),
      },
      runStore: executionStore({
        loadInputs: () =>
          Promise.resolve({
            runInput: null,
            completedNodeOutputs: [],
            abortRequested: false,
            nativeValueSources: { runInput: source, completedNodeOutputs: [] },
          }),
        heartbeat: () => {
          heartbeats++;
          return Promise.resolve({
            abortRequested: heartbeats > 1,
            ...(heartbeats > 1 ? { abortReason: 'canceled' as const } : {}),
            leaseExpiresAt: current.leaseExpiresAt,
          });
        },
        complete: (input) => {
          completion = input.outcome;
          return Promise.resolve({
            kind: 'committed',
            outboxEventId: current.delivery.outboxEventId,
          });
        },
      }),
      registry: {
        execute: () =>
          Promise.reject(new Error('Canceled execution is forbidden')),
      },
      nativeInputValues: {
        hydrateSource: ({ signal }) => {
          hydrationStarted = true;
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
          });
        },
      },
      engine: { prepare: () => registryPreparedAttempt() },
    });
    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(completion).toMatchObject({ status: 'canceled' });
    expect(hydrationStarted).toBe(true);
  });
  it('requires the source-aware owner and exact original byte identity without a legacy fallback', async () => {
    const dependencies = {
      chooseInline: () => undefined,
      reserve: () => Promise.reject(new Error('Preparation is forbidden')),
      writeReserved: () =>
        Promise.reject(new Error('Preparation is forbidden')),
      authorize: () =>
        Promise.reject(new Error('Legacy authorization is forbidden')),
      store: {
        getStream: () => Promise.reject(new Error('Object read is forbidden')),
      },
    };
    const request = {
      owner: { kind: 'attempt' as const, lease: current },
      source,
      signal: new AbortController().signal,
    };
    await expect(
      createWorkflowExecutionValueCodec(dependencies).hydrateSource(request),
    ).rejects.toThrow('Native accepted-source authorization is unavailable');
    const codec = createWorkflowExecutionValueCodec({
      ...dependencies,
      authorizeSource: () =>
        Promise.resolve({
          snapshot: {
            ...source.snapshot,
            serializedValue: '  null\n',
            byteLength: 7,
            sha256:
              '1de3b0dead53fa3985bd22be34a0318b79273ce0f081aae1b0759464c7c526f0',
          },
        }),
    });
    await expect(codec.hydrateSource(request)).rejects.toThrow(
      'Native accepted-source byte identity does not agree',
    );
    // Ordinary retained inline hydration does not acquire the new authority seam.
    await expect(
      codec.hydrate({
        owner: request.owner,
        reference: source.snapshot.reference,
        signal: request.signal,
      }),
    ).resolves.toBeNull();
  });
  it('delivers decoded native material to execution under a distinct heartbeat signal', async () => {
    const contextSignal = new AbortController().signal;
    const handler = createNodeAttemptHandler({
      workerId: 'worker-1',
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader: {
        close: () => Promise.resolve(),
        readForExecution: () =>
          Promise.resolve({
            kind: 'v3_projection',
            workflowVersion: {
              ...projection(),
              schemaVersion: 2,
              executableSchemaVersion: 3,
              checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
            },
          }),
      },
      runStore: executionStore({
        loadInputs: () =>
          Promise.resolve({
            runInput: 'unhydrated',
            completedNodeOutputs: [],
            abortRequested: false,
            nativeValueSources: { runInput: source, completedNodeOutputs: [] },
          }),
      }),
      registry: {
        execute: () => Promise.resolve({ kind: 'succeeded', output: null }),
      },
      nativeInputValues: {
        hydrateSource: (input) => {
          expect(input.signal).not.toBe(contextSignal);
          expect(input.owner).toEqual({ kind: 'attempt', lease: current });
          return Promise.resolve(null);
        },
      },
      engine: {
        prepare: () => ({
          ...registryPreparedAttempt(),
          execute: (input) => {
            expect(input.runInput).toBeNull();
            return registryPreparedAttempt().execute(input);
          },
        }),
      },
    });
    await expect(
      handler.handle(delivery(), { signal: contextSignal }),
    ).resolves.toEqual({ kind: 'committed' });
  });
  it('uses the composed bounded codec for an exact logical child artifact without preparing recovered bytes', async () => {
    const artifactId = '88888888-8888-4888-8888-888888888888';
    const upstream: Extract<
      NativeNodeAttemptValueSource,
      { slot: 'upstream_output' }
    > = {
      slot: 'upstream_output',
      source: {
        kind: 'workflow_call_result',
        workspaceId: current.workspaceId,
        parentRunId: current.runId,
        parentWorkflowVersionId: current.workflowVersionId,
        childRunId: '77777777-7777-4777-8777-777777777777',
        childWorkflowVersionId: '66666666-6666-4666-8666-666666666666',
        provenanceId: '99999999-9999-4999-8999-999999999999',
        nodeId: 'call',
        invocationKey: 'call-scope',
      },
      snapshot: {
        reference: { schemaVersion: 1, kind: 'artifact', artifactId },
        byteLength: 7,
        sha256:
          '2bfd14f43d17fc7cea24e0917a8879b4b2f880b8baeec1b9d90fbaad655e71bd',
      },
    };
    const metadata = {
      artifactId,
      workspaceId: current.workspaceId,
      byteLength: 7,
      sha256: upstream.snapshot.sha256,
      mediaType:
        'application/vnd.pertexo.execution-value+json;version=1' as const,
    };
    let downloaded: Readable | undefined;
    const runtime = createWorkflowExecutionValueRuntime({
      retentionMillis: 60_000,
      store: {
        put: () => Promise.reject(new Error('Recovery upload is forbidden')),
        getStream: () => {
          downloaded = Readable.from([Buffer.from('{"n":1}')]);
          return Promise.resolve({ body: downloaded, metadata });
        },
      },
      persistence: {
        reserve: () =>
          Promise.reject(new Error('Recovery reservation is forbidden')),
        assertReserved: () =>
          Promise.reject(new Error('Recovery preparation is forbidden')),
        finalize: () =>
          Promise.reject(new Error('Recovery finalization is forbidden')),
        authorize: () =>
          Promise.reject(new Error('Legacy authorization is forbidden')),
        authorizeSource: (request) => {
          expect(request.owner).toEqual({ kind: 'attempt', lease: current });
          expect(request.source).toBe(upstream);
          return Promise.resolve({
            snapshot: upstream.snapshot,
            artifact: { ...metadata, available: true },
          });
        },
      },
    });
    const output = await hydrateNativeNodeAttemptInputs({
      lease: current,
      inputs: {
        runInput: null,
        completedNodeOutputs: [],
        abortRequested: false,
        nativeValueSources: {
          runInput: null,
          completedNodeOutputs: [upstream],
        },
      },
      signal: new AbortController().signal,
      hydrate: runtime.hydrateSource,
      expectedUpstreamNodeOutputs: [
        { nodeId: 'call', invocationKey: 'call-scope' },
      ],
    });
    expect(output.completedNodeOutputs).toEqual([
      { nodeId: 'call', invocationKey: 'call-scope', value: { n: 1 } },
    ]);
    expect(output.runInput).toBeNull();
    expect(downloaded?.destroyed).toBe(true);
  });
  it('requires accepted-source authorization even for inline native material', async () => {
    const codec = createWorkflowExecutionValueCodec({
      chooseInline: () => undefined,
      reserve: () => Promise.reject(new Error('Preparation is forbidden')),
      writeReserved: () =>
        Promise.reject(new Error('Preparation is forbidden')),
      authorize: () =>
        Promise.reject(new Error('Legacy authorization is forbidden')),
      authorizeSource: () =>
        Promise.reject(new Error('Accepted source is unavailable')),
      store: {
        getStream: () => Promise.reject(new Error('Object read is forbidden')),
      },
    });
    await expect(
      codec.hydrateSource({
        owner: { kind: 'attempt', lease: current },
        source,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Accepted source is unavailable');
  });
  it('hydrates only the named native slots while preserving coordinator and structured inputs', async () => {
    const structuredCollection = {
      loopNodeId: 'loop',
      ordinal: 0,
      collection: [1],
      collectionSize: 1,
      declaredCollectionChecksum: 'a'.repeat(64),
    };
    const coordinatorInput = {
      ledger: { retained: { kind: 'artifact', artifactId: 'ordinary-json' } },
    };
    const inputs: NodeAttemptInputs = {
      runInput: 'unhydrated',
      completedNodeOutputs: [],
      abortRequested: false,
      structuredCollection,
      coordinatorInput,
      nativeValueSources: { runInput: source, completedNodeOutputs: [] },
    };
    const signal = new AbortController().signal;
    const output = await hydrateNativeNodeAttemptInputs({
      lease: current,
      inputs,
      signal,
      hydrate: (input) => {
        expect(input).toEqual({
          owner: { kind: 'attempt', lease: current },
          source,
          signal,
        });
        return Promise.resolve(null);
      },
    });
    expect(output.runInput).toBeNull();
    expect(output.structuredCollection).toBe(structuredCollection);
    expect(output.coordinatorInput).toBe(coordinatorInput);
  });
  it('leaves retained JSON resembling a reference wrapper untouched and performs no hydration', async () => {
    const retained: NodeAttemptInputs = {
      runInput: { schemaVersion: 1, kind: 'artifact', artifactId: 'user-json' },
      completedNodeOutputs: [
        { value: { slot: 'run_input', snapshot: source.snapshot } },
      ],
      abortRequested: false,
    };
    expect(
      await hydrateNativeNodeAttemptInputs({
        lease: current,
        inputs: retained,
        signal: new AbortController().signal,
        hydrate: () =>
          Promise.reject(new Error('Retained hydration is forbidden')),
      }),
    ).toBe(retained);
  });
  it('does no source work for a settled control request', async () => {
    const inputs: NodeAttemptInputs = {
      runInput: null,
      completedNodeOutputs: [],
      abortRequested: true,
      abortReason: 'canceled',
      nativeValueSources: { runInput: source, completedNodeOutputs: [] },
    };
    expect(
      await hydrateNativeNodeAttemptInputs({
        lease: current,
        inputs,
        signal: new AbortController().signal,
        hydrate: () =>
          Promise.reject(new Error('Control source work is forbidden')),
      }),
    ).toBe(inputs);
  });
  it('does not start the next source after heartbeat cancellation during hydration', async () => {
    const controller = new AbortController();
    const upstream: Extract<
      NativeNodeAttemptValueSource,
      { slot: 'upstream_output' }
    > = {
      slot: 'upstream_output',
      snapshot: source.snapshot,
      source: {
        ...source.source,
        kind: 'physical_output',
        nodeId: 'node',
        invocationKey: 'node-scope',
        attemptId: current.attemptId,
      },
    };
    let reads = 0;
    await expect(
      hydrateNativeNodeAttemptInputs({
        lease: current,
        inputs: {
          runInput: null,
          completedNodeOutputs: [],
          abortRequested: false,
          nativeValueSources: {
            runInput: source,
            completedNodeOutputs: [upstream],
          },
        },
        signal: controller.signal,
        expectedUpstreamNodeOutputs: [
          { nodeId: 'node', invocationKey: 'node-scope' },
        ],
        hydrate: () => {
          reads++;
          controller.abort();
          return Promise.resolve(null);
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(reads).toBe(1);
  });
});
