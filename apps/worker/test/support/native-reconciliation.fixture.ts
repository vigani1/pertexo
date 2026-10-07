import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { expect, vi } from 'vitest';
import { CORE_REGISTRY_RELEASE } from '@pertexo/nodes-core';
import { createRegistryRelease, type NodeManifest } from '@pertexo/node-sdk';
import {
  canonicalOutboxPayloadChecksum,
  type CoordinatorRunStore,
  type PublishedWorkflowV3Projection,
} from '@pertexo/database/execution';
import {
  composeExecutableCompatibilityReleaseV3,
  type CompiledWorkflowExecutableV3,
  type WorkflowCheckpointV3,
  type WorkflowCallStateV1,
  type WorkflowTransitionPlan,
  type JoinState,
} from '@pertexo/workflow-engine';
import { JOB_NAME } from '@pertexo/queue';
import { createCoordinatorHandler } from '../../src/execution/coordinator-handler.js';
import { createCoordinatorAdvanceEngine } from '../../src/execution/coordinator-engine.js';
import { COORDINATOR_VALUE_WORK_POLICY_DEFAULTS } from '../../src/execution/coordinator-value-work-lifetime.js';
import {
  RUN_ID,
  VERSION_ID,
  WORKSPACE_ID,
  WORKFLOW_ID,
} from './execution-engine.fixture.js';

// Same built private adapter boundary as the existing native settlement matrix.
const { commitCoordinatorAdvancePlan } = (await import(
  new URL(
    '../../../../packages/database/dist/execution/coordinator/coordinator-run-store-commit.js',
    import.meta.url,
  ).href
)) as {
  commitCoordinatorAdvancePlan: (
    pool: Pool,
    input: Parameters<CoordinatorRunStore['commitAdvancePlan']>[0],
    options: {
      nativeValueControlReadTimeoutMillis: number;
      runTimeoutFailureContextEnabled: false;
      workspaceInboxProducerEnabled: false;
      workflowTriggerOutcomesEnabled: false;
    },
  ) => ReturnType<CoordinatorRunStore['commitAdvancePlan']>;
};
export const id = (n: number) =>
  `88888888-8888-4888-8888-${String(n).padStart(12, '0')}`;
export const occurredAt = '2026-10-04T00:00:00.000Z';
export const { settleJoin } = (await import(
  new URL(
    '../../../../packages/workflow-engine/dist/transition/scheduling.js',
    import.meta.url,
  ).href
)) as {
  settleJoin: (join: JoinState) => {
    kind: 'satisfied' | 'unsatisfied' | 'waiting';
  };
};
const manifests = await Promise.all(
  (
    [
      ['parallel', 'CORE_PARALLEL_MANIFEST'],
      ['merge', 'CORE_MERGE_MANIFEST'],
      ['workflow-call', 'CORE_WORKFLOW_CALL_MANIFEST'],
    ] as const
  ).map(async ([directory, name]) => {
    const module = (await import(
      new URL(
        `../../../../packages/nodes-core/dist/${directory}/definition.js`,
        import.meta.url,
      ).href
    )) as Record<string, NodeManifest>;
    const manifest = module[name];
    if (manifest === undefined)
      throw new Error('Historical fixture definition missing');
    return manifest;
  }),
);
const extras = manifests.filter(
  (manifest) =>
    !CORE_REGISTRY_RELEASE.definitions.some(
      ({ definition }) =>
        definition.key === manifest.definition.key &&
        definition.version === manifest.definition.version,
    ),
);
export const nativeRelease = composeExecutableCompatibilityReleaseV3(
  createRegistryRelease({
    epoch: CORE_REGISTRY_RELEASE.epoch,
    definitions: [...CORE_REGISTRY_RELEASE.definitions, ...extras],
    executors: [
      ...CORE_REGISTRY_RELEASE.executors,
      ...extras.map((manifest) => ({
        executor: manifest.executor,
        abiVersion: manifest.executorAbi ?? 1,
        definitions: [manifest.definition],
        lifecycle: 'active' as const,
        policyReferences: manifest.policyReferences,
      })),
    ],
    policies: [
      ...CORE_REGISTRY_RELEASE.policies,
      { key: 'workflow.call', version: 1 },
    ],
  }),
);
export function projection(
  executable: CompiledWorkflowExecutableV3,
  versionId = VERSION_ID,
): PublishedWorkflowV3Projection {
  return {
    id: versionId,
    workspaceId: WORKSPACE_ID,
    workflowId: WORKFLOW_ID,
    versionNumber: 1,
    schemaVersion: 2,
    executableSchemaVersion: 3,
    executableJson: executable.envelope,
    checksum: executable.checksum,
    compatibilityReleaseEpoch: nativeRelease.epoch,
  };
}
export interface EventRow {
  sequence: number;
  type: string;
  created_at: Date;
  payload: Record<string, unknown>;
}
export type PhysicalRow = Record<string, unknown> & {
  invocation_key: string;
  attempt_id: string | null;
  node_run_id: string;
};
export function physicalRows(
  checkpoint: WorkflowCheckpointV3,
  values: ReadonlyMap<string, unknown>,
) {
  return checkpoint.invocations.map((invocation, index): PhysicalRow => {
    const attemptId =
      invocation.attemptNumber === 0
        ? null
        : invocation.output?.kind === 'inline'
          ? invocation.output.attemptId
          : id(100 + index);
    const value = values.get(invocation.nodeId);
    const output =
      value === undefined ? null : { schemaVersion: 1, kind: 'inline', value };
    const call = checkpoint.calls.find(
      ({ invocationKey }) => invocationKey === invocation.invocationKey,
    );
    return {
      invocation_key: invocation.invocationKey,
      node_id: invocation.nodeId,
      attempt_id: call?.declarationAttemptId ?? attemptId,
      node_run_id: id(200 + index),
      current_attempt_id: call?.declarationAttemptId ?? attemptId,
      attempt_number: attemptId === null ? null : invocation.attemptNumber,
      current_attempt_number:
        attemptId === null ? null : invocation.attemptNumber,
      attempt_status:
        attemptId === null
          ? null
          : call === undefined
            ? invocation.status
            : 'succeeded',
      node_status: invocation.status,
      attempt_output_ref: output,
      node_output_ref: output,
      node_input_ref: output,
      control_kind: call === undefined ? null : 'workflow_call',
      executor_failure_kind: null,
      resume_at: null,
      retry_due_at: null,
      retry_decision: null,
      wait_kind: null,
      branch_context: {
        ...(invocation.branchPath === undefined
          ? {}
          : { branchPath: invocation.branchPath }),
        ...(invocation.iterationPath === undefined
          ? {}
          : { iterationPath: invocation.iterationPath }),
      },
    };
  });
}

/** PostgreSQL I/O simulation only: no mock of engine, commit, child-control, event or outbox code. */
export function reconciliationFixture(input: {
  executable: CompiledWorkflowExecutableV3;
  checkpoint: WorkflowCheckpointV3;
  status: 'canceled' | 'timed_out';
  physical: PhysicalRow[];
  observations: readonly unknown[];
  facts: EventRow[];
  callFacts?: readonly WorkflowCallStateV1[];
  callee?: PublishedWorkflowV3Projection;
}) {
  let snapshot = {
    checkpoint: input.checkpoint,
    observations: input.observations,
    facts: input.facts,
    callFacts: input.callFacts ?? [],
  };
  let persisted = input.checkpoint;
  let fingerprint: string | null = null;
  let activePayload = payload(id(1));
  const receipts = new Set<string>();
  const childRequests = new Set<string>();
  const statements: { sql: string; values: unknown[] }[] = [];
  let scope: string | null = null;
  let timeout = 0;
  function payload(outboxEventId: string) {
    return {
      schemaVersion: 1 as const,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      outboxEventId,
    };
  }
  const client = new EventEmitter() as EventEmitter & {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  client.release = vi.fn();
  client.query = vi.fn(
    async (
      query: string | { text: string; rowMode?: string },
      values: unknown[] = [],
    ) => {
      await Promise.resolve();
      const sql = typeof query === 'string' ? query : query.text;
      statements.push({ sql, values });
      if (sql.includes("set_config('app.workspace_id'"))
        scope = String(values[0]);
      if (sql.includes("set_config('statement_timeout'"))
        timeout = Number.parseInt(String(values[0]), 10);
      if (sql === 'commit' || sql === 'rollback') {
        scope = null;
        timeout = 0;
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
          rows: [{ result: { kind: 'stopped', stop: { kind: input.status } } }],
        };
      if (sql.includes('select aggregate_id, aggregate_type'))
        return {
          rows: [
            {
              aggregate_id: RUN_ID,
              aggregate_type: 'workflow-run',
              job_name: JOB_NAME.advanceWorkflowRun,
              schema_version: 1,
              payload: activePayload,
              payload_checksum: canonicalOutboxPayloadChecksum(activePayload),
            },
          ],
        };
      if (sql.includes('select id from app.workflow_runs')) {
        expect(sql.replace(/\s+/gu, ' ').trim()).toBe(
          'select id from app.workflow_runs where workspace_id=$1 and id=$2 for no key update',
        );
        expect(scope).toBe(WORKSPACE_ID);
        expect(values).toEqual([WORKSPACE_ID, RUN_ID]);
        return { rows: [{ id: RUN_ID }] };
      }
      if (sql.includes('select checkpoint.revision')) {
        expect(statements.at(-2)?.sql).toContain(
          'select id from app.workflow_runs',
        );
        expect(sql).toContain('for no key update of checkpoint');
        return {
          rows: [
            {
              revision: persisted.revision,
              scheduler_state: persisted,
              last_transition_fingerprint: fingerprint,
              workflow_version_id: VERSION_ID,
              status: persisted.runStatus,
              cancel_requested_at:
                input.status === 'canceled' ? new Date(occurredAt) : null,
              deadline_expired: input.status === 'timed_out',
              trigger_type: 'manual',
              graph_schema_version: 2,
              executable_schema_version: 3,
              executable_checksum: input.executable.checksum,
            },
          ],
        };
      }
      if (sql.includes('as high_water'))
        return {
          rows: [
            {
              high_water:
                snapshot.facts.at(-1)?.sequence ??
                snapshot.checkpoint.nextEventSequence - 1,
            },
          ],
        };
      if (sql.includes('as fact_count'))
        return {
          rows: [
            {
              fact_count: snapshot.facts.length,
              storage_bytes: String(snapshot.facts.length * 500),
              maximum_storage_bytes: snapshot.facts.length ? '500' : '0',
            },
          ],
        };
      if (sql.includes('select event.sequence'))
        return { rows: snapshot.facts };
      if (sql.includes('select attempt.id as attempt_id'))
        return {
          rows: input.physical.filter(
            ({ attempt_id }) =>
              attempt_id !== null &&
              (values[1] as string[]).includes(attempt_id),
          ),
        };
      if (sql.includes('select executable_schema_version'))
        return {
          rows: [
            {
              executable_schema_version: 3,
              executable_json: input.executable.envelope,
            },
          ],
        };
      if (sql.includes('as attempt_count'))
        return {
          rows: input.physical
            .filter(({ invocation_key }) =>
              (values[2] as string[]).includes(invocation_key),
            )
            .map((row) => ({
              ...row,
              status: row.node_status,
              output_ref: row.node_output_ref,
              attempt_count: row.attempt_id === null ? 0 : 1,
            })),
        };
      if (sql.includes('read_workflow_call_facts'))
        return { rows: snapshot.callFacts.map((fact) => ({ fact })) };
      if (sql.includes('select node.invocation_key'))
        return { rows: input.physical };
      if (sql.includes('select id, invocation_key, current_attempt_id'))
        return {
          rows: input.physical.map((row) => ({ ...row, id: row.node_run_id })),
        };
      if (sql.includes('select completed_at, payload_checksum'))
        return {
          rows: [
            {
              payload_checksum: canonicalOutboxPayloadChecksum(activePayload),
              completed_at: receipts.has(activePayload.outboxEventId)
                ? new Date(occurredAt)
                : null,
            },
          ],
        };
      if (sql.includes('propagate_workflow_call_control')) {
        expect(sql).toBe(
          'select app.propagate_workflow_call_control($1::uuid,$2::integer,$3::uuid,$4::text,$5::jsonb) as result',
        );
        expect(values).toHaveLength(5);
        expect(values[0]).toBe(RUN_ID);
        expect(values[1]).toBe(snapshot.checkpoint.revision);
        expect(values[3]).toBe(
          input.status === 'canceled' ? 'cancel_requested' : 'deadline_expired',
        );
        expect(JSON.parse(String(values[4]))).toEqual({
          outboxEventId: activePayload.outboxEventId,
          payloadChecksum: canonicalOutboxPayloadChecksum(activePayload),
        });
        const child = String(values[2]);
        childRequests.add(child);
        return {
          rows: [
            {
              result:
                input.status === 'canceled'
                  ? { kind: 'requested' }
                  : { kind: 'wake' },
            },
          ],
        };
      }
      if (sql.includes('update app.run_checkpoints')) {
        if (persisted.revision !== values[5]) return { rows: [], rowCount: 0 };
        persisted = JSON.parse(String(values[2])) as WorkflowCheckpointV3;
        fingerprint = String(values[6]);
      }
      if (sql.includes('update app.inbox_receipts'))
        receipts.add(activePayload.outboxEventId);
      if (sql.startsWith('update app.node_runs node')) {
        const row = input.physical.find(
          ({ invocation_key }) => invocation_key === values[2],
        );
        if (row === undefined) return { rows: [], rowCount: 0 };
        row.node_status = values[3];
        row.node_output_ref = values[4];
        row.control_kind = values[3] === 'waiting' ? 'workflow_call' : null;
      } else if (sql.startsWith('update app.node_runs')) {
        const row = input.physical.find(
          ({ invocation_key }) => invocation_key === values[4],
        );
        if (
          row === undefined ||
          !['pending', 'ready', 'waiting'].includes(String(row.node_status))
        )
          return { rows: [], rowCount: 0 };
        row.node_status = values[0];
      }
      if (
        sql.includes('insert into app.run_events') &&
        sql.includes('returning sequence')
      )
        return { rows: [{ sequence: 1 }], rowCount: 1 };
      if (sql.includes('insert into app.run_events'))
        return {
          rows: [],
          rowCount: (JSON.parse(String(values[2])) as unknown[]).length,
        };
      if (sql.includes('insert into "app"."outbox_events"'))
        return { rows: [[values[0], WORKSPACE_ID, occurredAt]], rowCount: 1 };
      if (
        sql.includes('insert into app.node_runs') ||
        sql.includes('insert into app.node_attempts')
      )
        throw new Error('Unexpected fresh admission during reconciliation');
      return { rows: [], rowCount: 1 };
    },
  );
  const pool = {
    options: { connectionTimeoutMillis: 100 },
    connect: (callback?: (error: undefined, client: PoolClient) => void) => {
      if (callback !== undefined)
        callback(undefined, client as unknown as PoolClient);
      return Promise.resolve(client as unknown as PoolClient);
    },
  } as unknown as Pool;
  const demand = vi.fn(() => {
    throw new Error('Unexpected stopped value demand');
  });
  const plans: WorkflowTransitionPlan[] = [];
  const runStore: CoordinatorRunStore = {
    close: vi.fn(),
    acknowledgeAdvanceDelivery: vi.fn(),
    commitAdvancePlan: (request) => {
      plans.push(request.plan as WorkflowTransitionPlan);
      return commitCoordinatorAdvancePlan(pool, request, {
        nativeValueControlReadTimeoutMillis: 2000,
        runTimeoutFailureContextEnabled: false,
        workspaceInboxProducerEnabled: false,
        workflowTriggerOutcomesEnabled: false,
      });
    },
    loadAdvanceState: () =>
      Promise.resolve({
        kind: 'ready',
        state: {
          runId: RUN_ID,
          workflowVersionId: VERSION_ID,
          checkpoint: snapshot.checkpoint,
          observations: snapshot.observations,
          controlDeclarations: {
            lastSequence:
              snapshot.facts.at(-1)?.sequence ??
              snapshot.checkpoint.nextEventSequence - 1,
            identities: [],
          },
          ...(input.callee === undefined
            ? {}
            : {
                workflowCalls: { declarations: [], facts: snapshot.callFacts },
                calleeProjections: [input.callee],
              }),
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
          workflowVersion: projection(input.executable),
        }),
    },
    engine: createCoordinatorAdvanceEngine({ admissionRelease: nativeRelease }),
    clock: { now: () => occurredAt },
    maximumAdmissions: 1,
    nativeValueWork: {
      policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
      hydrateControlSource: demand,
    },
  });
  return {
    statements,
    plans,
    demand,
    childRequests,
    get checkpoint() {
      return persisted;
    },
    handle: (attemptsMade = 0) =>
      handler.handle(
        {
          name: JOB_NAME.advanceWorkflowRun,
          data: activePayload,
          transport: {
            attemptsMade,
            jobId: `outbox-${activePayload.outboxEventId}`,
          },
        },
        { signal: new AbortController().signal },
      ),
    next: (next: Omit<typeof snapshot, 'checkpoint'>) => {
      snapshot = { ...next, checkpoint: persisted };
      activePayload = payload(id(2));
    },
  };
}
