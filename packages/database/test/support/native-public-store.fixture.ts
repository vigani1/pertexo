import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  platformExecutableRegistryHistory,
  PLATFORM_REGISTRY_RELEASE_WORKFLOW_CALL_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_WORKFLOW_CALL_STAGED,
} from '@pertexo/node-catalog';
import {
  buildWorkflowExecutableV3,
  composeExecutableCompatibilityRelease,
  composeExecutableCompatibilityReleaseV3,
  createExecutableCompatibilityReleaseHistory,
  createWorkflowCheckpointV3,
  advanceWorkflow,
} from '@pertexo/workflow-engine';
import type { WorkflowCallableDeclarationV1 } from '@pertexo/workflow-model/callable-graph-contract';
import type { WorkflowCallPinV1 } from '@pertexo/workflow-model/workflow-call-contract';
import type { JsonValue } from '@pertexo/workflow-model/canonical-json';
import {
  createCoordinatorRunStore,
  createNodeAttemptRunStore,
  serializeWorkflowExecutionJsonValueV3,
  type CoordinatorRunStore,
} from '../../src/execution.js';
import { createWorkspaceDatabase } from '../../src/database.js';
import { acceptWorkflowRun } from '../../src/execution/runs/execution-acceptance.js';
import {
  createCompatibilityReleaseMaintenance,
  createCompatibilityReleaseReadinessProbe,
} from '../../src/compatibility/testing.js';
import {
  actorId,
  apiBaseUrl,
  asOwner,
  asRuntime,
  databaseUrl,
  migrationBaseUrl,
  parseDatabaseConfig,
  workspaceA,
  workerBaseUrl,
  testDelivery,
} from '../coordinator-run-store.fixtures.js';

const nativeFingerprints = [
  PLATFORM_REGISTRY_RELEASE_WORKFLOW_CALL_ACTIVE.fingerprint,
  PLATFORM_REGISTRY_RELEASE_WORKFLOW_CALL_STAGED.fingerprint,
];
const registry = platformExecutableRegistryHistory('workflow_call_activation');
const compilerReleases = registry.map((release) =>
  nativeFingerprints.includes(release.fingerprint)
    ? composeExecutableCompatibilityReleaseV3(release)
    : composeExecutableCompatibilityRelease(release),
);
export const nativeDescriptions =
  createExecutableCompatibilityReleaseHistory(compilerReleases).descriptions;
const activeRelease = compilerReleases.at(-1);
if (activeRelease === undefined)
  throw new Error('Native compiler release missing');

export const nativeStoreConfig = parseDatabaseConfig({
  connectionString: databaseUrl(workerBaseUrl),
  max: 6,
  connectionTimeoutMillis: 1000,
});

export function createNativeCoordinatorFixtureStore() {
  const store: CoordinatorRunStore = createCoordinatorRunStore(
    nativeStoreConfig,
    undefined,
    {
      expectedCompatibilityReleases: nativeDescriptions.slice(-2),
      workflowCallAdmission: {
        compatibilityReleases: nativeDescriptions.slice(-2),
        createInitialCheckpoint: (projection, engineVersion) =>
          createWorkflowCheckpointV3({
            engineVersion,
            workflowVersionId: projection.id,
            iterationBudget: 1000,
          }),
      },
      hydrateNativeControlSource: async (input) => {
        if (store.readCoordinatorControlSource === undefined)
          throw new Error('Native control read port missing');
        const read = await store.readCoordinatorControlSource({
          ...input,
          readTimeoutMillis: 2000,
        });
        if (read.kind !== 'ready')
          throw new Error('Native control read stopped');
        const original = read.valueSource.snapshot.serializedValue;
        if (original === undefined)
          throw new Error('Inline native control bytes missing');
        return JSON.parse(original) as unknown;
      },
      // The framework lifetime port grants no value or SQL authority. Both
      // inspections execute the actual protected owner, with a bounded signal.
      withNativeResultPreparation: async (input, prepare) => {
        const signal = AbortSignal.any([
          input.signal,
          AbortSignal.timeout(2000),
        ]);
        const inspect = () =>
          input.inspectOwner({
            owner: input.owner,
            signal,
            readTimeoutMillis: 2000,
          });
        if ((await inspect()).kind !== 'active')
          throw new Error('Native fixture scope stopped');
        const result = await prepare(signal);
        if ((await inspect()).kind !== 'active')
          throw new Error('Native fixture scope stopped');
        return result;
      },
    },
  );
  return store;
}

export async function loadNativePlan(
  run: Pick<
    Awaited<ReturnType<typeof acceptNativeFixture>>,
    'runId' | 'versionId' | 'executable'
  >,
  store: ReturnType<typeof createNativeCoordinatorFixtureStore>,
  revision: number,
  completion?: Parameters<typeof advanceWorkflow>[0]['callableCompletion'],
  calleeDeclarations = new Map<string, WorkflowCallableDeclarationV1>(),
) {
  const delivery = await testDelivery(workspaceA, run.runId, revision);
  const signal = new AbortController().signal;
  const loaded = await store.loadAdvanceState({
    workspaceId: workspaceA,
    runId: run.runId,
    delivery,
    signal,
  });
  if (loaded.kind !== 'ready')
    throw new Error('Native fixture checkpoint not ready');
  const plan = await advanceWorkflow({
    runId: run.runId,
    workflowVersionId: run.versionId,
    executable: run.executable,
    checkpoint: loaded.state.checkpoint,
    observations: loaded.state.observations,
    loadCoordinatorControlDeclaration: async (identity, signal) => {
      const owner = {
        workspaceId: workspaceA,
        runId: run.runId,
        workflowVersionId: run.versionId,
        expectedRevision: revision,
        delivery,
      };
      const window = loaded.state.controlDeclarations;
      if (
        window === undefined ||
        store.loadCoordinatorControlSources === undefined ||
        store.readCoordinatorControlSource === undefined
      )
        throw new Error('Native control inventory port missing');
      const inventory = await store.loadCoordinatorControlSources({
        owner,
        lastSequence: window.lastSequence,
        expected: window.identities,
        signal,
        readTimeoutMillis: 2000,
      });
      if (inventory.kind === 'stopped') return inventory;
      const source = inventory.sources.find(
        (source) =>
          source.sequence === identity.sequence &&
          source.attemptId === identity.attemptId &&
          source.invocationKey === identity.invocationKey,
      );
      if (source === undefined)
        throw new Error('Native demanded control source missing');
      const read = await store.readCoordinatorControlSource({
        owner,
        source,
        signal,
        readTimeoutMillis: 2000,
      });
      if (read.kind === 'stopped') return read;
      const original = read.valueSource.snapshot.serializedValue;
      if (original === undefined)
        throw new Error('Native control original bytes missing');
      return {
        kind: 'ready',
        material: {
          ...identity,
          output: source.output,
          valueIdentity: {
            reference: source.valueSource.valueIdentity.reference,
            sha256: source.valueSource.valueIdentity.sha256,
            byteLength: source.valueSource.valueIdentity.byteLength,
          },
          value: JSON.parse(original) as unknown,
        },
      };
    },
    ...(completion === undefined ? {} : { callableCompletion: completion }),
    ...(loaded.state.workflowCalls === undefined
      ? {}
      : {
          workflowCalls: { ...loaded.state.workflowCalls, calleeDeclarations },
        }),
    occurredAt: new Date().toISOString(),
    maximumAdmissions: 10,
    signal,
  });
  const commit = () =>
    store.commitAdvancePlan({
      workspaceId: workspaceA,
      runId: run.runId,
      workflowVersionId: run.versionId,
      delivery,
      plan,
      signal,
    });
  return { plan, delivery, commit, state: loaded.state };
}

/** Real append-only prepare/probe/approve/activate protocol on the owned DB. */
export async function activateNativeFixture(): Promise<void> {
  const maintenance = createCompatibilityReleaseMaintenance(
    parseDatabaseConfig({
      connectionString: databaseUrl(migrationBaseUrl),
    }),
  );
  try {
    for (let index = 1; index < nativeDescriptions.length; index += 1) {
      const predecessor = nativeDescriptions[index - 1];
      const target = nativeDescriptions[index];
      if (predecessor === undefined || target === undefined)
        throw new Error('Release history gap');
      const probes = [apiBaseUrl, workerBaseUrl].map((base) =>
        createCompatibilityReleaseReadinessProbe(
          parseDatabaseConfig({ connectionString: databaseUrl(base) }),
          [predecessor, target],
        ),
      );
      try {
        await maintenance.prepare({
          actorId: 'native-public-store',
          actorKind: 'deployment',
          expectedPredecessor: predecessor,
          reason: 'Owned real-PG public-store qualification',
          target,
        });
        for (const probe of probes) await probe.checkTarget(target);
        const deploymentId = randomUUID();
        const approvalId = randomUUID();
        for (const roleKind of ['api', 'worker'] as const)
          await maintenance.recordPreactivation({
            artifactId: `native-public-${roleKind}`,
            checkId: randomUUID(),
            deploymentId,
            roleKind,
            target,
          });
        await maintenance.approve({
          actorId: 'native-public-store',
          approvalId,
          deploymentId,
          reason: 'Real API and worker release probes passed',
          requiredApiArtifacts: ['native-public-api'],
          requiredWorkerArtifacts: ['native-public-worker'],
          target,
        });
        await maintenance.activate({
          activationId: randomUUID(),
          actorId: 'native-public-store',
          actorKind: 'deployment',
          approvalId,
          expectedPredecessor: predecessor,
          reason: 'Owned fixture activation',
        });
      } finally {
        await Promise.all(probes.map((probe) => probe.close()));
      }
    }
  } finally {
    await maintenance.close();
  }
}

export async function acceptNativeFixture(
  selector: WorkflowCallableDeclarationV1['resultSelector'],
  callPin?: WorkflowCallPinV1,
  shape: 'single' | 'loop' | 'parallel' | 'branch' | 'nested' = 'single',
) {
  const node = (id: string, key: string, version = 1) => ({
    id,
    definition: { key, version },
    position: { x: 0, y: 0 },
    configVersion: version,
    config: {},
    inputMappings: {},
    connectionRefs: {},
  });
  const graph = {
    schemaVersion: 2,
    settings: {},
    nodes: [
      node('manual', 'core.manual'),
      ...(shape === 'loop' || shape === 'nested'
        ? [
            {
              ...node('loop', 'core.foreach'),
              inputMappings: { items: { kind: 'literal', value: [1, 2] } },
              structured: {
                kind: 'for_each',
                maxIterations: 2,
                maxConcurrency: 1,
                body: {
                  schemaVersion: 1,
                  settings: {},
                  nodes:
                    shape === 'nested'
                      ? [
                          {
                            ...node('inner', 'core.foreach'),
                            inputMappings: {
                              items: { kind: 'literal', value: [3, 4] },
                            },
                            structured: {
                              kind: 'for_each',
                              maxIterations: 2,
                              maxConcurrency: 1,
                              body: {
                                schemaVersion: 1,
                                settings: {},
                                nodes: [node('deep', 'core.set')],
                                edges: [],
                                inputPorts: ['item', 'ordinal'],
                                outputPorts: ['result'],
                              },
                            },
                          },
                        ]
                      : [
                          {
                            ...node('body', 'core.set'),
                            inputMappings: {
                              item: {
                                kind: 'structured_input',
                                port: 'item',
                                path: '$',
                              },
                            },
                          },
                        ],
                  edges: [],
                  inputPorts: ['item', 'ordinal'],
                  outputPorts: ['result'],
                },
              },
            },
            node('finish', 'core.set'),
          ]
        : []),
      ...(shape === 'parallel'
        ? [
            {
              ...node('fan', 'core.parallel', 3),
              config: {
                branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
                maxConcurrency: 1,
              },
            },
            node('left', 'core.set'),
            node('right', 'core.set'),
            {
              ...node('join', 'core.merge', 3),
              config: { parallelNodeId: 'fan', policy: { kind: 'all' } },
            },
            node('finish', 'core.set'),
          ]
        : []),
      ...(shape === 'branch'
        ? [
            {
              ...node('condition', 'core.condition'),
              inputMappings: { condition: { kind: 'literal', value: true } },
            },
            node('selected', 'core.set'),
            node('unused', 'core.set'),
          ]
        : []),
      ...(callPin === undefined
        ? []
        : [
            {
              ...node('call', 'core.workflow_call'),
              config: callPin,
            },
          ]),
    ],
    edges:
      shape === 'parallel'
        ? [
            {
              id: 'manual-fan',
              source: { nodeId: 'manual', port: 'out' },
              target: { nodeId: 'fan', port: 'in' },
            },
            {
              id: 'fan-left',
              source: { nodeId: 'fan', port: 'branch-01' },
              target: { nodeId: 'left', port: 'in' },
            },
            {
              id: 'fan-right',
              source: { nodeId: 'fan', port: 'branch-02' },
              target: { nodeId: 'right', port: 'in' },
            },
            {
              id: 'left-join',
              source: { nodeId: 'left', port: 'out' },
              target: { nodeId: 'join', port: 'branch-01' },
            },
            {
              id: 'right-join',
              source: { nodeId: 'right', port: 'out' },
              target: { nodeId: 'join', port: 'branch-02' },
            },
            {
              id: 'join-finish',
              source: { nodeId: 'join', port: 'out' },
              target: { nodeId: 'finish', port: 'in' },
            },
          ]
        : shape === 'branch'
          ? [
              {
                id: 'manual-condition',
                source: { nodeId: 'manual', port: 'out' },
                target: { nodeId: 'condition', port: 'in' },
              },
              {
                id: 'condition-selected',
                source: { nodeId: 'condition', port: 'true' },
                target: { nodeId: 'selected', port: 'in' },
              },
              {
                id: 'condition-unused',
                source: { nodeId: 'condition', port: 'false' },
                target: { nodeId: 'unused', port: 'in' },
              },
            ]
          : shape === 'loop' || shape === 'nested'
            ? [
                {
                  id: 'manual-loop',
                  source: { nodeId: 'manual', port: 'out' },
                  target: { nodeId: 'loop', port: 'in' },
                },
                {
                  id: 'loop-finish',
                  source: { nodeId: 'loop', port: 'out' },
                  target: { nodeId: 'finish', port: 'in' },
                },
              ]
            : callPin === undefined
              ? []
              : [
                  {
                    id: 'manual-call',
                    source: { nodeId: 'manual', port: 'out' },
                    target: { nodeId: 'call', port: 'in' },
                  },
                ],
    callable: {
      schemaVersion: 1,
      input: {
        type: 'object',
        properties: { answer: { type: 'number' } },
        required: ['answer'],
      },
      result: {
        type: 'object',
        properties: { answer: { type: 'number' } },
        required: ['answer'],
      },
      resultSelector: selector,
    },
  };
  const executable = buildWorkflowExecutableV3({
    graph,
    release: activeRelease,
  });
  const versionId = randomUUID();
  const workflowId = randomUUID();
  await asOwner(workspaceA, (client) =>
    client.query(
      'insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,$3,$4)',
      [workflowId, workspaceA, 'Native public-store fixture', actorId],
    ),
  );
  await asOwner(workspaceA, (client) =>
    client.query(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,schema_version,
      graph_json,checksum,executable_schema_version,executable_json,compatibility_release_epoch,published_by)
     values($1,$2,$3,$4,2,$5,$6,3,$7,$8,$9)`,
      [
        versionId,
        workspaceA,
        workflowId,
        1,
        graph,
        executable.checksum,
        executable.envelope,
        executable.envelope.compatibilityReleaseEpoch,
        actorId,
      ],
    ),
  );
  const initialCheckpoint = createWorkflowCheckpointV3({
    engineVersion: 'native-public-v3',
    workflowVersionId: versionId,
    iterationBudget: 1000,
  });
  const keyHash = randomUUID().replaceAll('-', '').repeat(2);
  const api = createWorkspaceDatabase(
    parseDatabaseConfig({ connectionString: databaseUrl(apiBaseUrl) }),
  );
  try {
    const accepted = await api.withWorkspace(
      workspaceA,
      async (transaction) => {
        await transaction.db.execute(
          sql`select set_config('app.actor_id',${actorId},true)`,
        );
        await transaction.db
          .execute(sql`select app.lock_manual_workflow_run_start(${actorId}::uuid,
        ${workflowId}::uuid,${`workflow:${workflowId}:manual`},${keyHash})`);
        return acceptWorkflowRun(transaction, {
          operation: 'workflow.run.accept',
          triggerType: 'manual',
          workflowId,
          workflowVersionId: versionId,
          engineVersion: initialCheckpoint.engineVersion,
          initialCheckpoint,
          runInput: { answer: 42 },
          scope: `workflow:${workflowId}:manual`,
          keyHash,
          requestHash: keyHash,
        });
      },
    );
    const outbox = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ payload_checksum: string }>(
        'select payload_checksum from app.outbox_events where workspace_id=$1 and id=$2',
        [workspaceA, accepted.outboxEventId],
      ),
    );
    const checksum = outbox.rows[0]?.payload_checksum;
    if (checksum === undefined)
      throw new Error('Canonical native outbox missing');
    return {
      workflowId,
      runId: accepted.runId,
      versionId,
      executable,
      initialCheckpoint,
      delivery: {
        outboxEventId: accepted.outboxEventId,
        payloadChecksum: checksum,
      },
    };
  } finally {
    await api.close();
  }
}

/** Only canonical public attempt ports; no fabricated leases or SQL replies. */
export async function completeNativePhysical(
  runId: string,
  admitted: Readonly<{ nodeRunId: string; attemptId: string }>,
  output: Record<string, JsonValue>,
  declaration = false,
) {
  const store = createNodeAttemptRunStore(nativeStoreConfig);
  try {
    const rows = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ id: string; payload_checksum: string }>(
        "select id,payload_checksum from app.outbox_events where workspace_id=$1 and job_name='execute-node-attempt' and payload->>'attemptId'=$2",
        [workspaceA, admitted.attemptId],
      ),
    );
    const delivery = rows.rows[0];
    if (delivery === undefined)
      throw new Error('Canonical native attempt delivery missing');
    const signal = new AbortController().signal;
    const claim = await store.claimDelivery({
      workspaceId: workspaceA,
      runId,
      nodeRunId: admitted.nodeRunId,
      attemptId: admitted.attemptId,
      delivery: {
        outboxEventId: delivery.id,
        payloadChecksum: delivery.payload_checksum,
      },
      leaseDurationSeconds: 30,
      workerId: 'native-public-store',
      signal,
    });
    if (claim.kind !== 'claimed') throw new Error('Native attempt not claimed');
    const inputs = await store.loadInputs({
      lease: claim.lease,
      upstreamNodeOutputs: [],
      signal,
    });
    const original = serializeWorkflowExecutionJsonValueV3(output);
    const prepared = {
      reference: {
        schemaVersion: 1 as const,
        kind: 'inline' as const,
        value: output,
      },
      sha256: createHash('sha256').update(original).digest('hex'),
      byteLength: Buffer.byteLength(original),
    };
    if (declaration) {
      if (
        store.recordCallDeclarationInput === undefined ||
        store.readCallDeclarationInput === undefined ||
        store.completeCallDeclaration === undefined
      )
        throw new Error('Native Call declaration ports missing');
      await store.recordCallDeclarationInput({
        lease: claim.lease,
        ...prepared,
        signal,
      });
      const read = await store.readCallDeclarationInput({
        lease: claim.lease,
        signal,
      });
      const completed = await store.completeCallDeclaration({
        lease: claim.lease,
        signal,
      });
      return { inputs, completed, read };
    }
    const completed = await store.complete({
      lease: claim.lease,
      outcome: { status: 'succeeded', output },
      nativeOutput: prepared,
      signal,
    });
    return { inputs, completed, read: undefined };
  } finally {
    await store.close();
  }
}
