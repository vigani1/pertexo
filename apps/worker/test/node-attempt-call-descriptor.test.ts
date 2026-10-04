import { createRegistryRelease, type NodeManifest } from '@pertexo/node-sdk';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
  NodeAttemptLease,
  PublishedWorkflowV3Projection,
  CoordinatorRunStore,
} from '@pertexo/database/execution';
import { CORE_REGISTRY_RELEASE } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutableV3,
  composeExecutableCompatibilityReleaseV3,
  createWorkflowCheckpointV3,
  invocationKey,
} from '@pertexo/workflow-engine';
import { workflowCallableContractIdentityV1 } from '@pertexo/workflow-model/workflow-call-closure';
import { describe, expect, it, vi } from 'vitest';
import { createNodeAttemptExecutionEngine } from '../src/execution/node-attempt-engine.js';
import { createCoordinatorAdvanceEngine } from '../src/execution/coordinator-engine.js';
import { advanceNativeCoordinator } from '../src/execution/coordinator-native-demand-advance.js';
import { createCoordinatorCallDeclarationHydration } from '../src/execution/coordinator-call-declaration-hydration.js';
import { COORDINATOR_VALUE_WORK_POLICY_DEFAULTS } from '../src/execution/coordinator-value-work-lifetime.js';
import {
  RUN_ID,
  VERSION_ID,
  WORKFLOW_ID,
  WORKSPACE_ID,
  graph,
} from './support/execution-engine.fixture.js';

// Local staged manifest: this test does not register native Call in a serving catalog.
const baseManifest = CORE_REGISTRY_RELEASE.definitions[0];
if (baseManifest === undefined) throw new Error('Missing base manifest');
const manifest: NodeManifest = {
  ...baseManifest,
  definition: { key: 'core.workflow_call', version: 1 },
  executor: { key: 'core.workflow_call', version: 1 },
  family: 'logic',
  configSchema: { type: 'object', additionalProperties: true },
  inputSchema: { type: 'object', additionalProperties: true },
  outputSchema: { type: 'object', additionalProperties: true },
  ports: { inputs: ['in'], outputs: ['out'] },
  retryClass: 'unsafe',
  policyReferences: [
    { key: 'node.json.bounded', version: 1 },
    { key: 'workflow.call', version: 1 },
  ],
};
const release = composeExecutableCompatibilityReleaseV3(
  createRegistryRelease({
    epoch: CORE_REGISTRY_RELEASE.epoch,
    definitions: [...CORE_REGISTRY_RELEASE.definitions, manifest],
    executors: [
      ...CORE_REGISTRY_RELEASE.executors,
      {
        executor: manifest.executor,
        abiVersion: 1,
        definitions: [manifest.definition],
        lifecycle: 'active',
        policyReferences: manifest.policyReferences,
      },
    ],
    policies: [
      ...CORE_REGISTRY_RELEASE.policies,
      { key: 'workflow.call', version: 1 },
    ],
  }),
);
const callable = {
  schemaVersion: 1 as const,
  input: {
    type: 'object' as const,
    properties: { name: { type: 'string' as const } },
    required: ['name'],
  },
  result: { type: 'object' as const, properties: {}, required: [] },
  resultSelector: { kind: 'literal' as const, value: {} },
};
const child = buildWorkflowExecutableV3({
  release,
  graph: { ...graph(), schemaVersion: 2, callable },
});

function artifactCall() {
  const value = { name: 'x'.repeat(300_000) };
  const bytes = Buffer.from(JSON.stringify(value));
  const snapshot = {
    reference: {
      schemaVersion: 1 as const,
      kind: 'artifact' as const,
      artifactId: lease.attemptId,
    },
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length,
  };
  const source = {
    invocationKey: lease.invocationKey,
    nodeId: 'call',
    declarationAttemptId: lease.attemptId,
    calleeVersionId: VERSION_ID,
    snapshot,
  };
  const metadata = {
    artifactId: lease.attemptId,
    workspaceId: WORKSPACE_ID,
    sha256: snapshot.sha256,
    byteLength: bytes.length,
    mediaType: 'application/vnd.pertexo.execution-value+json;version=1',
  };
  const controller = new AbortController();
  const read = vi.fn<
    NonNullable<CoordinatorRunStore['readCoordinatorCallDeclaration']>
  >(() => Promise.resolve({ kind: 'ready', source }));
  const inspect = vi.fn<
    NonNullable<CoordinatorRunStore['inspectCoordinatorValueReadOwner']>
  >(() =>
    Promise.resolve({
      kind: 'active',
      databaseNow: '2026-10-04T00:00:00Z',
      deadlineAt: null,
    }),
  );
  const getStream = vi.fn(() =>
    Promise.resolve({ body: Readable.from([bytes]), metadata }),
  );
  const runStore: CoordinatorRunStore = {
    loadAdvanceState: vi.fn(),
    commitAdvancePlan: vi.fn(),
    acknowledgeAdvanceDelivery: vi.fn(),
    close: vi.fn(),
    readCoordinatorCallDeclaration: read,
    inspectCoordinatorValueReadOwner: inspect,
  };
  const checkpoint = {
    ...createWorkflowCheckpointV3({
      engineVersion: 'test',
      workflowVersionId: VERSION_ID,
      iterationBudget: 0,
    }),
    runStatus: 'running',
    admittedInvocationKeys: [
      invocationKey({ workflowVersionId: VERSION_ID, nodeId: 'manual' }),
      lease.invocationKey,
    ],
    invocations: [
      {
        nodeId: 'manual',
        invocationKey: invocationKey({
          workflowVersionId: VERSION_ID,
          nodeId: 'manual',
        }),
        attemptNumber: 1,
        status: 'succeeded',
        output: { kind: 'inline', attemptId: RUN_ID },
      },
      {
        nodeId: 'call',
        invocationKey: lease.invocationKey,
        attemptNumber: 1,
        status: 'running',
      },
    ],
  };
  const engine = createCoordinatorAdvanceEngine({ admissionRelease: release });
  const advance = vi.fn<typeof engine.advance>((input) =>
    engine.advance(input),
  );
  const input = {
    engine: { advance },
    workspaceId: WORKSPACE_ID,
    delivery: lease.delivery,
    runStore,
    valueWork: {
      policy: {
        ...COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
        controlPollMillis: 100,
      },
      hydrateCallDeclaration: createCoordinatorCallDeclarationHydration(
        runStore,
        { getStream },
        2_000,
      ),
    },
    advance: {
      runId: RUN_ID,
      workflowVersionId: VERSION_ID,
      projection: projection(parent),
      checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: checkpoint.nextEventSequence,
          occurredAt: '2026-10-04T00:00:00.000Z',
          invocationKey: lease.invocationKey,
          attemptId: lease.attemptId,
          attemptNumber: 1,
          status: 'succeeded',
          output: { kind: 'artifact', artifactId: lease.attemptId },
        },
      ],
      workflowCalls: {
        declarations: [
          {
            ...source,
            input: { kind: 'artifact' as const, artifactId: lease.attemptId },
            inputChecksum: snapshot.sha256,
            value: undefined,
            artifactSource: source,
          },
        ],
        facts: [],
      },
      calleeProjections: [projection(child)],
      occurredAt: '2026-10-04T00:00:00.000Z',
      maximumAdmissions: 1,
      signal: controller.signal,
    },
  };
  return {
    input,
    value,
    snapshot,
    read,
    inspect,
    getStream,
    advance,
    controller,
    metadata,
  };
}

describe('actual coordinator engine Call artifact composition (external database/storage ports)', () => {
  it.each(['attempt', 'checksum', 'callee'] as const)(
    'refuses freshly returned substituted %s metadata before storage or child derivation',
    async (kind) => {
      const selected = artifactCall();
      const source = selected.input.advance.workflowCalls.declarations[0];
      if (source === undefined) throw new Error('Missing Call fixture');
      selected.read.mockResolvedValue({
        kind: 'ready',
        source: {
          ...source.artifactSource,
          ...(kind === 'attempt' ? { declarationAttemptId: RUN_ID } : {}),
          ...(kind === 'callee' ? { calleeVersionId: WORKFLOW_ID } : {}),
          ...(kind === 'checksum'
            ? { snapshot: { ...selected.snapshot, sha256: 'b'.repeat(64) } }
            : {}),
        },
      });
      await expect(advanceNativeCoordinator(selected.input)).rejects.toThrow(
        'identity differs',
      );
      expect(selected.getStream).not.toHaveBeenCalled();
      expect(selected.advance).not.toHaveBeenCalled();
    },
  );
  it('hydrates original bytes before deriving one child intent and preserves exact source identity', async () => {
    const selected = artifactCall();
    const result = await advanceNativeCoordinator(selected.input);
    expect(result).toMatchObject({
      kind: 'transition',
      plan: {
        workflowCalls: {
          declarations: [
            {
              invocationKey: lease.invocationKey,
              inputChecksum: selected.snapshot.sha256,
              input: { kind: 'artifact', artifactId: lease.attemptId },
            },
          ],
        },
      },
    });
    expect(
      selected.advance.mock.calls[0]?.[0].workflowCalls?.declarations[0]?.value,
    ).toEqual(selected.value);
    expect(
      selected.advance.mock.calls[0]?.[0].workflowCalls?.declarations[0],
    ).not.toHaveProperty('artifactSource');
    expect(selected.read).toHaveBeenCalledOnce();
    expect(selected.getStream).toHaveBeenCalledOnce();
    expect(selected.inspect.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
  it('uses a typed current-owner stop before any storage read or child derivation', async () => {
    const selected = artifactCall();
    selected.read.mockResolvedValue({
      kind: 'stopped',
      stop: { kind: 'canceled' },
    });
    await expect(advanceNativeCoordinator(selected.input)).resolves.toEqual({
      kind: 'value_work_stopped',
      stop: { kind: 'canceled' },
    });
    expect(selected.getStream).not.toHaveBeenCalled();
    expect(selected.advance).not.toHaveBeenCalled();
  });
  it.each(['context', 'owner'] as const)(
    'joins and destroys an in-flight stream on %s loss without deriving a child',
    async (kind) => {
      const selected = artifactCall();
      let started = false;
      const body = new Readable({
        read() {
          started = true;
          if (kind === 'context') selected.controller.abort();
        },
      });
      selected.getStream.mockResolvedValue({
        body,
        metadata: selected.metadata,
      });
      selected.inspect.mockImplementation(() =>
        Promise.resolve(
          started && kind === 'owner'
            ? { kind: 'stopped', stop: { kind: 'stale', revision: 1 } }
            : {
                kind: 'active',
                databaseNow: '2026-10-04T00:00:00Z',
                deadlineAt: null,
              },
        ),
      );
      await expect(
        advanceNativeCoordinator(selected.input),
      ).resolves.toMatchObject({
        kind: 'value_work_stopped',
        stop: {
          kind: kind === 'context' ? 'context_aborted' : 'stale',
        },
      });
      expect(body.destroyed).toBe(true);
      expect(selected.advance).not.toHaveBeenCalled();
    },
  );
});
const pin = {
  workflowId: WORKFLOW_ID,
  versionId: VERSION_ID,
  checksum: child.checksum,
  callableContractIdentity: workflowCallableContractIdentityV1(callable),
};
const base = graph();
const source = base.nodes[0];
const sink = base.nodes[1];
if (source === undefined || sink === undefined)
  throw new Error('Missing base nodes');
const parent = buildWorkflowExecutableV3({
  release,
  graph: {
    ...base,
    schemaVersion: 2,
    nodes: [
      source,
      {
        ...sink,
        id: 'call',
        definition: manifest.definition,
        config: pin,
        inputMappings: { name: { kind: 'literal', value: 'input' } },
      },
    ],
    edges: [
      {
        id: 'manual-call',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'call', port: 'in' },
      },
    ],
  },
});
function projection(value: typeof parent): PublishedWorkflowV3Projection {
  return {
    id: VERSION_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: WORKFLOW_ID,
    schemaVersion: 2,
    versionNumber: 1,
    executableSchemaVersion: 3,
    executableJson: value.envelope,
    checksum: value.checksum,
    compatibilityReleaseEpoch: release.epoch,
  };
}
const lease: NodeAttemptLease = {
  workspaceId: WORKSPACE_ID,
  workflowVersionId: VERSION_ID,
  runId: RUN_ID,
  nodeRunId: '55555555-5555-4555-8555-555555555555',
  attemptId: '66666666-6666-4666-8666-666666666666',
  attemptNumber: 1,
  admissionKind: 'execute',
  invocationKey: `${VERSION_ID}|call|b:|i:`,
  nodeId: 'call',
  sideEffectClass: 'unsafe',
  workerId: 'worker',
  fenceToken: 1,
  leaseExpiresAt: new Date(),
  delivery: {
    outboxEventId: '77777777-7777-4777-8777-777777777777',
    payloadChecksum: 'a'.repeat(64),
  },
};
function attempt() {
  const prepared = createNodeAttemptExecutionEngine({
    admissionRelease: release,
  }).prepare({ lease, projection: projection(parent) });
  const execute = vi.fn().mockResolvedValue({
    kind: 'succeeded' as const,
    output: { name: 'input' },
  });
  const input = {
    runInput: {},
    completedNodeOutputs: [],
    abortRequested: false,
    registry: { execute },
    signal: new AbortController().signal,
  };
  return { prepared, execute, input };
}
describe('native Call retained descriptor', () => {
  it('verifies the exact pinned V3 artifact and supplies its callable descriptor', async () => {
    const { prepared, execute, input } = attempt();
    expect(prepared.callPin).toEqual(pin);
    expect(prepared.inputPersistence).toBe('workflow_call_declaration');
    await expect(
      prepared.execute({
        ...input,
        pinnedCallableProjection: projection(child),
      }),
    ).resolves.toMatchObject({ kind: 'succeeded' });
    expect(execute).toHaveBeenCalledOnce();
  });
  it.each([
    'absent',
    'workspace',
    'version',
    'workflow',
    'checksum',
    'body',
  ] as const)('rejects %s mismatch before dispatch', async (kind) => {
    const { prepared, execute, input } = attempt();
    const childProjection = projection(child);
    const other = '99999999-9999-4999-8999-999999999999';
    const candidate =
      kind === 'absent'
        ? undefined
        : kind === 'workspace'
          ? { ...childProjection, workspaceId: other }
          : kind === 'version'
            ? { ...childProjection, id: other }
            : kind === 'workflow'
              ? { ...childProjection, workflowId: other }
              : kind === 'checksum'
                ? {
                    ...childProjection,
                    checksum: `wf:v3:sha256:${'f'.repeat(64)}`,
                  }
                : { ...childProjection, executableJson: parent.envelope };
    await expect(
      prepared.execute({
        ...input,
        ...(candidate === undefined
          ? {}
          : { pinnedCallableProjection: candidate }),
      }),
    ).rejects.toBeDefined();
    expect(execute).not.toHaveBeenCalled();
  });
});
