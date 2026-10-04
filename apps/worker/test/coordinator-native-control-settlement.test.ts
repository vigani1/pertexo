import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';
import { CORE_REGISTRY_RELEASE } from '@pertexo/nodes-core';
import { createRegistryRelease, type NodeManifest } from '@pertexo/node-sdk';
import {
  canonicalOutboxPayloadChecksum,
  type CoordinatorRunStore,
} from '@pertexo/database/execution';
import {
  advanceWorkflow,
  buildWorkflowExecutableV3,
  composeExecutableCompatibilityReleaseV3,
  createWorkflowCheckpointV3,
} from '@pertexo/workflow-engine';
import { JOB_NAME } from '@pertexo/queue';
import { createCoordinatorHandler } from '../src/execution/coordinator-handler.js';
import { createCoordinatorAdvanceEngine } from '../src/execution/coordinator-engine.js';
import { COORDINATOR_VALUE_WORK_POLICY_DEFAULTS } from '../src/execution/coordinator-value-work-lifetime.js';
import {
  graph,
  RUN_ID,
  WORKSPACE_ID,
  WORKFLOW_ID,
  VERSION_ID,
} from './support/execution-engine.fixture.js';

// Actual built adapter, not a new public test-only export or mocked module.
const { commitCoordinatorAdvancePlan } = (await import(
  new URL(
    '../../../packages/database/dist/execution/coordinator/coordinator-run-store-commit.js',
    import.meta.url,
  ).href
)) as {
  commitCoordinatorAdvancePlan: (
    pool: Pool,
    input: Parameters<CoordinatorRunStore['commitAdvancePlan']>[0],
    options: Readonly<{
      nativeValueControlReadTimeoutMillis: number;
      runTimeoutFailureContextEnabled: false;
      workspaceInboxProducerEnabled: false;
      workflowTriggerOutcomesEnabled: false;
    }>,
  ) => ReturnType<CoordinatorRunStore['commitAdvancePlan']>;
};
const id = (n: number) =>
  `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;
const occurredAt = '2026-10-04T00:00:00.000Z';
const { CORE_FOR_EACH_MANIFEST: forEachManifest } = (await import(
  new URL(
    '../../../packages/nodes-core/dist/for-each/definition.js',
    import.meta.url,
  ).href
)) as { CORE_FOR_EACH_MANIFEST: NodeManifest };
const historicalManifests = await Promise.all(
  (
    [
      ['condition', 'CORE_CONDITION_MANIFEST'],
      ['parallel', 'CORE_PARALLEL_MANIFEST'],
      ['merge', 'CORE_MERGE_MANIFEST'],
    ] as const
  ).map(async ([directory, name]) => {
    const module = (await import(
      new URL(
        `../../../packages/nodes-core/dist/${directory}/definition.js`,
        import.meta.url,
      ).href
    )) as Record<string, NodeManifest>;
    const manifest = module[name];
    if (manifest === undefined)
      throw new Error('Missing historical fixture definition');
    return manifest;
  }),
);
const extraManifests = [forEachManifest, ...historicalManifests].filter(
  (manifest) =>
    !CORE_REGISTRY_RELEASE.definitions.some(
      ({ definition }) =>
        definition.key === manifest.definition.key &&
        definition.version === manifest.definition.version,
    ),
);

it.each(
  (['for_each', 'branch', 'parallel'] as const).flatMap((kind) =>
    (['canceled', 'timed_out'] as const).flatMap((status) =>
      (kind === 'parallel'
        ? (['inline'] as const)
        : (['inline', 'artifact'] as const)
      ).flatMap((representation) =>
        [false, true].map((lostReply) => ({
          kind,
          status,
          representation,
          lostReply,
        })),
      ),
    ),
  ),
)(
  'actual handler/engine/commit settles $kind $status $representation (lostReply=$lostReply) without demand or duplicate writes',
  async ({ kind, status, representation, lostReply }) => {
    const base = graph();
    const manual = base.nodes[0];
    if (manual === undefined) throw new Error('manual missing');
    const body = {
      ...manual,
      id: 'body',
      definition: { key: 'core.set', version: 1 },
      inputMappings: {
        value: { kind: 'structured_input' as const, port: 'item', path: '$' },
      },
    };
    const loop = {
      ...manual,
      id: 'loop',
      definition: { key: 'core.foreach', version: 1 },
      inputMappings: { items: { kind: 'literal' as const, value: [1] } },
      structured: {
        kind: 'for_each' as const,
        maxIterations: 2,
        maxConcurrency: 1,
        body: {
          schemaVersion: 2 as const,
          settings: {},
          nodes: [body],
          edges: [],
          inputPorts: ['item', 'ordinal'],
          outputPorts: ['result'],
        },
      },
    };
    const terminate = {
      ...base.nodes[1],
      inputMappings: {
        result: { kind: 'node_output' as const, nodeId: 'loop', path: '$' },
      },
    };
    let nativeGraph: unknown = {
      schemaVersion: 2 as const,
      settings: {},
      nodes: [manual, loop, terminate],
      edges: [
        {
          id: 'edge',
          source: { nodeId: manual.id, port: 'out' },
          target: { nodeId: loop.id, port: 'in' },
        },
        {
          id: 'end',
          source: { nodeId: 'loop', port: 'out' },
          target: { nodeId: 'terminate', port: 'in' },
        },
      ],
    };
    if (kind === 'branch') {
      nativeGraph = {
        schemaVersion: 2,
        settings: {},
        nodes: [
          manual,
          {
            ...manual,
            id: 'branch',
            definition: { key: 'core.condition', version: 1 },
            inputMappings: { condition: { kind: 'literal', value: true } },
          },
          {
            ...terminate,
            inputMappings: {
              result: { kind: 'node_output', nodeId: 'branch', path: '$' },
            },
          },
        ],
        edges: [
          {
            id: 'start',
            source: { nodeId: 'manual', port: 'out' },
            target: { nodeId: 'branch', port: 'in' },
          },
          {
            id: 'end',
            source: { nodeId: 'branch', port: 'true' },
            target: { nodeId: 'terminate', port: 'in' },
          },
        ],
      };
    }
    if (kind === 'parallel') {
      const set = { ...manual, definition: { key: 'core.set', version: 1 } };
      nativeGraph = {
        schemaVersion: 2,
        settings: {},
        nodes: [
          manual,
          {
            ...manual,
            id: 'parallel',
            definition: { key: 'core.parallel', version: 1 },
            config: {
              branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
              maxConcurrency: 1,
            },
          },
          { ...set, id: 'left' },
          { ...set, id: 'right' },
          {
            ...manual,
            id: 'merge',
            definition: { key: 'core.merge', version: 1 },
            config: { parallelNodeId: 'parallel', policy: { kind: 'all' } },
          },
          {
            ...terminate,
            inputMappings: {
              result: { kind: 'node_output', nodeId: 'merge', path: '$' },
            },
          },
        ],
        edges: [
          {
            id: 'start',
            source: { nodeId: 'manual', port: 'out' },
            target: { nodeId: 'parallel', port: 'in' },
          },
          {
            id: 'left',
            source: { nodeId: 'parallel', port: 'branch-01' },
            target: { nodeId: 'left', port: 'in' },
          },
          {
            id: 'right',
            source: { nodeId: 'parallel', port: 'branch-02' },
            target: { nodeId: 'right', port: 'in' },
          },
          {
            id: 'join-left',
            source: { nodeId: 'left', port: 'out' },
            target: { nodeId: 'merge', port: 'branch-01' },
          },
          {
            id: 'join-right',
            source: { nodeId: 'right', port: 'out' },
            target: { nodeId: 'merge', port: 'branch-02' },
          },
          {
            id: 'end',
            source: { nodeId: 'merge', port: 'out' },
            target: { nodeId: 'terminate', port: 'in' },
          },
        ],
      };
    }
    const release = composeExecutableCompatibilityReleaseV3(
      createRegistryRelease({
        epoch: CORE_REGISTRY_RELEASE.epoch,
        definitions: [...CORE_REGISTRY_RELEASE.definitions, ...extraManifests],
        executors: [
          ...CORE_REGISTRY_RELEASE.executors,
          ...extraManifests.map((manifest) => ({
            executor: manifest.executor,
            abiVersion: 1,
            definitions: [manifest.definition],
            lifecycle: 'active' as const,
            policyReferences: manifest.policyReferences,
          })),
        ],
        policies: CORE_REGISTRY_RELEASE.policies,
      }),
    );
    const executable = buildWorkflowExecutableV3({
      graph: nativeGraph,
      release,
    });
    const advance = {
      runId: RUN_ID,
      workflowVersionId: VERSION_ID,
      executable,
      occurredAt,
      maximumAdmissions: 1,
      signal: new AbortController().signal,
    };
    const initial = await advanceWorkflow({
      ...advance,
      checkpoint: createWorkflowCheckpointV3({
        engineVersion: 'test',
        workflowVersionId: VERSION_ID,
        iterationBudget: 10,
      }),
      observations: [],
    });
    const first = initial.attempts[0];
    if (first === undefined) throw new Error('manual attempt missing');
    const current = await advanceWorkflow({
      ...advance,
      checkpoint: initial.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: initial.checkpoint.nextEventSequence,
          attemptId: id(1),
          invocationKey: first.invocationKey,
          attemptNumber: 1,
          status: 'succeeded',
          output: { kind: 'inline', attemptId: id(1) },
          occurredAt,
        },
      ],
    });
    const control = current.attempts[0];
    if (control === undefined) throw new Error('control attempt missing');
    const fact = {
      sequence: current.checkpoint.nextEventSequence,
      type: 'node.succeeded',
      created_at: new Date(occurredAt),
      payload: {
        schemaVersion: 1,
        attemptId: id(2),
        nodeRunId: id(3),
        invocationKey: control.invocationKey,
        nodeId: control.nodeId,
        attemptNumber: 1,
      },
    };
    const physical = {
      branch_context: Object.fromEntries(
        ['branchPath', 'iterationPath'].flatMap((field) => {
          const invocation = current.checkpoint.invocations.find(
            ({ invocationKey }) => invocationKey === control.invocationKey,
          );
          const value =
            invocation === undefined
              ? undefined
              : (Reflect.get(invocation, field) as unknown);
          return value === undefined ? [] : [[field, value]];
        }),
      ),
      attempt_id: id(2),
      attempt_number: 1,
      attempt_status: 'succeeded',
      attempt_output_ref:
        representation === 'artifact'
          ? { schemaVersion: 1, kind: 'artifact', artifactId: id(4) }
          : {
              schemaVersion: 1,
              kind: 'inline',
              value: { items: ['one'], iterationCount: 1 },
            },
      node_output_ref:
        representation === 'artifact'
          ? { schemaVersion: 1, kind: 'artifact', artifactId: id(4) }
          : {
              schemaVersion: 1,
              kind: 'inline',
              value: { items: ['one'], iterationCount: 1 },
            },
      executor_failure_kind: null,
      invocation_key: control.invocationKey,
      node_run_id: id(3),
      node_id: control.nodeId,
      current_attempt_id: id(2),
      node_status: 'succeeded',
      control_kind: null,
      resume_at: null,
      retry_due_at: null,
      retry_decision: null,
      wait_kind: null,
    };
    const cancellation = {
      sequence: fact.sequence + 1,
      type: 'run.cancel_requested',
      created_at: new Date(occurredAt),
      payload: { schemaVersion: 1 },
    };
    const facts = status === 'canceled' ? [fact, cancellation] : [fact];
    const payload = {
      schemaVersion: 1 as const,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      outboxEventId: id(5),
    };
    const checksum = canonicalOutboxPayloadChecksum(payload);
    let committedPlan:
      Parameters<CoordinatorRunStore['commitAdvancePlan']>[0] | undefined;
    let persistedCheckpoint: unknown = current.checkpoint;
    let fingerprint: string | null = null;
    let revision = current.checkpoint.revision;
    let scope: string | null = null;
    let timeout = 0;
    let receipt = false;
    let lost = false;
    const client = new EventEmitter() as EventEmitter & {
      query: ReturnType<typeof vi.fn>;
      release: ReturnType<typeof vi.fn>;
    };
    client.release = vi.fn();
    client.query = vi.fn(async (sql: string, values: unknown[] = []) => {
      await Promise.resolve();
      if (sql.includes("set_config('app.workspace_id'"))
        scope = String(values[0]);
      if (sql.includes("set_config('statement_timeout'"))
        timeout = Number.parseInt(String(values[0]), 10);
      if (sql === 'commit' || sql === 'rollback') {
        scope = null;
        timeout = 0;
        if (sql === 'commit' && receipt && lostReply && !lost) {
          lost = true;
          throw new Error('Simulated committed response loss');
        }
      }
      if (sql.includes('current_setting'))
        return {
          rows: [
            {
              workspace_id: scope,
              actor_id: null,
              discovery_scope: null,
              statement_timeout_millis: timeout,
            },
          ],
        };
      if (sql.includes('inspect_native_coordinator_value_owner'))
        return {
          rows: [{ result: { kind: 'stopped', stop: { kind: status } } }],
        };
      if (sql.includes('select aggregate_id, aggregate_type'))
        return {
          rows: [
            {
              aggregate_id: RUN_ID,
              aggregate_type: 'workflow-run',
              job_name: JOB_NAME.advanceWorkflowRun,
              schema_version: 1,
              payload,
              payload_checksum: checksum,
            },
          ],
        };
      if (sql.includes('select checkpoint.revision'))
        return {
          rows: [
            {
              revision,
              scheduler_state: persistedCheckpoint,
              last_transition_fingerprint: fingerprint,
              workflow_version_id: VERSION_ID,
              status:
                revision === current.checkpoint.revision ? 'running' : status,
              cancel_requested_at:
                status === 'canceled' ? new Date(occurredAt) : null,
              deadline_expired: status === 'timed_out',
              trigger_type: 'manual',
              graph_schema_version: 2,
              executable_schema_version: 3,
              executable_checksum: executable.checksum,
            },
          ],
        };
      if (sql.includes('as high_water'))
        return { rows: [{ high_water: facts.at(-1)?.sequence }] };
      if (sql.includes('as fact_count'))
        return {
          rows: [
            {
              fact_count: facts.length,
              storage_bytes: '1000',
              maximum_storage_bytes: '500',
            },
          ],
        };
      if (sql.includes('select event.sequence')) return { rows: facts };
      if (sql.includes('select attempt.id as attempt_id'))
        return { rows: [physical] };
      if (sql.includes('select executable_schema_version'))
        return {
          rows: [
            {
              executable_schema_version: 3,
              executable_json: executable.envelope,
            },
          ],
        };
      if (sql.includes('select node.invocation_key'))
        return {
          rows: [
            physical,
            {
              ...physical,
              attempt_id: id(1),
              invocation_key: first.invocationKey,
              attempt_output_ref: {
                schemaVersion: 1,
                kind: 'inline',
                value: {},
              },
              node_output_ref: { schemaVersion: 1, kind: 'inline', value: {} },
            },
          ],
        };
      if (sql.includes('select id from app.artifacts'))
        return { rows: [{ id: id(4) }] };
      if (sql.includes('select id, invocation_key, current_attempt_id'))
        return {
          rows: [
            {
              id: id(3),
              invocation_key: control.invocationKey,
              current_attempt_id: id(2),
              current_attempt_number: 1,
            },
          ],
        };
      if (sql.includes('select completed_at, payload_checksum'))
        return {
          rows: [
            {
              payload_checksum: checksum,
              completed_at: receipt ? new Date(occurredAt) : null,
            },
          ],
        };
      if (sql.includes('update app.run_checkpoints')) {
        revision = Number(values[0]);
        persistedCheckpoint = JSON.parse(String(values[2]));
        fingerprint = String(values[6]);
      }
      if (sql.includes('update app.inbox_receipts')) receipt = true;
      if (sql.includes('insert into app.run_events'))
        return {
          rows: [],
          rowCount: (JSON.parse(String(values[2])) as unknown[]).length,
        };
      return { rows: [], rowCount: 1 };
    });
    const pool = {
      options: { connectionTimeoutMillis: 100 },
      connect: (callback?: (error: undefined, client: PoolClient) => void) => {
        if (callback !== undefined)
          callback(undefined, client as unknown as PoolClient);
        return Promise.resolve(client as unknown as PoolClient);
      },
    } as unknown as Pool;
    const demand = vi.fn();
    const commit = vi.fn<CoordinatorRunStore['commitAdvancePlan']>((input) => {
      committedPlan = input;
      return commitCoordinatorAdvancePlan(pool, input, {
        nativeValueControlReadTimeoutMillis: 2000,
        runTimeoutFailureContextEnabled: false,
        workspaceInboxProducerEnabled: false,
        workflowTriggerOutcomesEnabled: false,
      });
    });
    const runStore: CoordinatorRunStore = {
      close: vi.fn(),
      acknowledgeAdvanceDelivery: vi.fn(),
      commitAdvancePlan: commit,
      loadAdvanceState: () =>
        Promise.resolve({
          kind: 'ready',
          state: {
            runId: RUN_ID,
            workflowVersionId: VERSION_ID,
            checkpoint: current.checkpoint,
            observations: [
              {
                kind: 'outcome',
                sequence: fact.sequence,
                attemptId: id(2),
                invocationKey: control.invocationKey,
                attemptNumber: 1,
                status: 'succeeded',
                output:
                  representation === 'artifact'
                    ? { kind: 'artifact', artifactId: id(4) }
                    : { kind: 'inline', attemptId: id(2) },
                occurredAt,
              },
              ...(status === 'canceled'
                ? [
                    {
                      kind: 'cancel_requested',
                      sequence: fact.sequence + 1,
                      occurredAt,
                    },
                  ]
                : [{ kind: 'deadline_expired', occurredAt }]),
            ],
            controlDeclarations: {
              lastSequence: facts.at(-1)?.sequence ?? 0,
              identities: [],
            },
          },
        }),
      inspectCoordinatorValueReadOwner: demand,
      loadCoordinatorControlSources: demand,
      readCoordinatorControlSource: demand,
    };
    const handler = createCoordinatorHandler({
      runStore,
      reader: {
        close: vi.fn(),
        readForExecution: () =>
          Promise.resolve({
            kind: 'v3_projection',
            workflowVersion: {
              id: VERSION_ID,
              workspaceId: WORKSPACE_ID,
              workflowId: WORKFLOW_ID,
              versionNumber: 1,
              schemaVersion: 2,
              executableSchemaVersion: 3,
              executableJson: executable.envelope,
              checksum: executable.checksum,
              compatibilityReleaseEpoch: release.epoch,
            },
          }),
      },
      engine: createCoordinatorAdvanceEngine({ admissionRelease: release }),
      clock: { now: () => occurredAt },
      maximumAdmissions: 1,
      nativeValueWork: {
        policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
        hydrateControlSource: demand,
      },
    });
    const delivered = {
      name: JOB_NAME.advanceWorkflowRun,
      data: payload,
      transport: { attemptsMade: 0, jobId: `outbox-${id(5)}` },
    } as const;
    if (lostReply)
      await expect(
        handler.handle(delivered, { signal: advance.signal }),
      ).rejects.toThrow('Simulated committed response loss');
    else
      await expect(
        handler.handle(delivered, { signal: advance.signal }),
      ).resolves.toMatchObject({ kind: 'committed' });
    expect(demand).not.toHaveBeenCalled();
    expect(committedPlan?.plan).toMatchObject({
      checkpoint: { runStatus: status, remainingIterationBudget: 10 },
      attempts: [],
    });
    if (committedPlan === undefined) throw new Error('commit missing');
    const writes = client.query.mock.calls.filter(([sql]) =>
      String(sql).startsWith('update app.node_runs'),
    ).length;
    await expect(
      handler.handle(
        {
          ...delivered,
          transport: { ...delivered.transport, attemptsMade: 1 },
        },
        { signal: advance.signal },
      ),
    ).resolves.toMatchObject({
      kind: 'already_committed',
    });
    expect(
      client.query.mock.calls.filter(([sql]) =>
        String(sql).startsWith('update app.node_runs'),
      ),
    ).toHaveLength(writes);
    expect(demand).not.toHaveBeenCalled();
  },
);
