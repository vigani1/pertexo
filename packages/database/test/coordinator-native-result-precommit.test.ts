import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1 } from '../src/execution/artifacts/execution-value-representation.js';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { commitCoordinatorAdvancePlan } from '../src/execution/coordinator/coordinator-run-store-commit.js';
import {
  parseTransitionPlan,
  transitionFingerprint,
} from '../src/execution/coordinator/coordinator-run-store-plan.js';
import { canonicalOutboxPayloadChecksum } from '../src/execution/transport/outbox.js';
import { serializeCoordinatorCheckpoint } from '../src/execution/coordinator/coordinator-checkpoint.js';
import type {
  NativeCoordinatorResultPreparationScope,
  NativeCoordinatorResultSourceHydrator,
  NativeCoordinatorResultValuePreparer,
} from '../src/execution/coordinator/coordinator-native-value-read-contract.js';

const id = (n: number) =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const payload = {
  schemaVersion: 1,
  workspaceId: id(1),
  runId: id(2),
  outboxEventId: id(4),
};
const delivery = {
  outboxEventId: id(4),
  payloadChecksum: canonicalOutboxPayloadChecksum(payload),
};
const serializedValue = '{"name":"result"}';
const valueIdentity = {
  reference: { schemaVersion: 1, kind: 'inline' },
  sha256: createHash('sha256').update(serializedValue).digest('hex'),
  byteLength: Buffer.byteLength(serializedValue),
  mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
};
const runInputSource = {
  slot: 'run_input',
  source: {
    kind: 'run_input',
    workspaceId: id(1),
    runId: id(2),
    workflowVersionId: id(3),
    provenanceId: id(7),
  },
};
const checkpoint = {
  schemaVersion: 3,
  engineVersion: 'engine-v3',
  workflowVersionId: id(3),
  revision: 1,
  runStatus: 'succeeded',
  nextEventSequence: 3,
  readySet: [],
  admittedInvocationKeys: [],
  invocations: [],
  joins: [],
  loops: [],
  calls: [],
  branchSelections: [],
  remainingIterationBudget: 1000,
  cancelRequested: false,
  deadlineExpired: false,
};
const plan = parseTransitionPlan({
  expectedRevision: 0,
  expectedNextEventSequence: 2,
  consumedThroughEventSequence: 1,
  checkpoint,
  events: [
    {
      schemaVersion: 1,
      sequence: 2,
      name: 'run.succeeded',
      occurredAt: '2026-10-04T00:00:00.000Z',
    },
  ],
  nodeRunAdmissions: [],
  attempts: [],
  callableResult: { kind: 'succeeded', value: { name: 'result' }, sources: [] },
});

/** External pg only: real precommit, tenant owner and full-fingerprint CAS recovery. */
class ResultClient extends EventEmitter {
  public readonly sql: string[] = [];
  public releases = 0;
  private workspace: string | null = null;
  private timeout = 0;
  public constructor(
    private readonly stop: boolean,
    private readonly wrongFingerprint = false,
    private readonly sourceMode?: 'run_input' | 'wrong_source',
    private readonly fresh = false,
    private readonly recoveryPlan = plan,
    private readonly recoveryDrift?: 'checkpoint' | 'version' | 'delivery',
  ) {
    super();
  }
  public async query(sql: string, values: unknown[] = []) {
    await Promise.resolve();
    this.sql.push(sql);
    if (sql.includes("set_config('app.workspace_id'"))
      this.workspace = values[0] as string;
    if (sql.includes("set_config('statement_timeout'"))
      this.timeout = Number.parseInt(String(values[0]), 10);
    if (sql === 'commit' || sql === 'rollback') {
      this.workspace = null;
      this.timeout = 0;
    }
    if (sql.includes('current_setting'))
      return {
        rows: [
          {
            workspace_id: this.workspace,
            actor_id: null,
            discovery_scope: null,
            statement_timeout_millis: this.timeout,
          },
        ],
      };
    if (sql.includes('inspect_native_coordinator_value_owner'))
      return {
        rows: [
          {
            result: this.stop
              ? {
                  kind: 'stopped',
                  stop:
                    this.recoveryPlan === plan
                      ? { kind: 'stale', revision: 1 }
                      : { kind: 'unavailable', reason: 'control_read_failed' },
                }
              : {
                  kind: 'active',
                  databaseNow: '2026-10-04T00:00:00Z',
                  deadlineAt: '2026-10-04T01:00:00Z',
                },
          },
        ],
      };
    if (sql.includes('select version.executable_json'))
      return {
        rows: [
          {
            executable_json: {
              schemaVersion: 3,
              graph: {
                nodes: [],
                callable: {
                  schemaVersion: 1,
                  input: { type: 'object', properties: {}, required: [] },
                  result: {
                    type: 'object',
                    properties: { name: { type: 'string' } },
                    required: ['name'],
                  },
                  resultSelector:
                    this.sourceMode === undefined
                      ? {
                          kind: 'literal',
                          value: { name: 'result' },
                        }
                      : { kind: 'run_input', path: '$' },
                },
              },
            },
          },
        ],
      };
    if (sql.includes('load_native_coordinator_value_sources')) {
      expect(JSON.parse(String(values[0]))).toEqual({
        workspaceId: id(1),
        runId: id(2),
        workflowVersionId: id(3),
        expectedRevision: 0,
        delivery,
      });
      return {
        rows: [
          {
            result: {
              kind: 'ready',
              projection: {
                runInput: { ...runInputSource, valueIdentity },
                outputs: [],
              },
            },
          },
        ],
      };
    }
    if (sql.includes('read_native_coordinator_value_source'))
      return {
        rows: [
          {
            result: {
              kind: 'ready',
              valueSource: {
                ...runInputSource,
                source: {
                  ...runInputSource.source,
                  provenanceId:
                    this.sourceMode === 'wrong_source' ? id(8) : id(7),
                },
                snapshot: {
                  reference: {
                    schemaVersion: 1,
                    kind: 'inline',
                    value: { name: 'result' },
                  },
                  serializedValue,
                  sha256: valueIdentity.sha256,
                  byteLength: valueIdentity.byteLength,
                },
              },
            },
          },
        ],
      };
    if (sql.includes('select aggregate_id, aggregate_type'))
      return {
        rows: [
          {
            aggregate_id: id(2),
            aggregate_type: 'workflow-run',
            job_name: 'advance-workflow-run',
            schema_version: 1,
            payload,
            payload_checksum:
              this.recoveryDrift === 'delivery'
                ? 'f'.repeat(64)
                : delivery.payloadChecksum,
          },
        ],
      };
    if (sql.includes('select checkpoint.revision'))
      return {
        rows: [
          {
            revision: this.fresh ? 0 : 1,
            scheduler_state: this.fresh
              ? {
                  ...checkpoint,
                  revision: 0,
                  runStatus: 'running',
                  nextEventSequence: 2,
                }
              : (JSON.parse(
                  serializeCoordinatorCheckpoint(
                    this.recoveryDrift === 'checkpoint'
                      ? {
                          ...this.recoveryPlan.checkpoint,
                          remainingIterationBudget: 999,
                        }
                      : this.recoveryPlan.checkpoint,
                  ),
                ) as unknown),
            last_transition_fingerprint: this.wrongFingerprint
              ? 'f'.repeat(64)
              : transitionFingerprint({
                  plan: this.recoveryPlan,
                  workflowVersionId: id(3),
                  traceparent: undefined,
                }),
            workflow_version_id:
              this.recoveryDrift === 'version' ? id(8) : id(3),
            status: this.fresh
              ? 'running'
              : this.recoveryPlan.checkpoint.runStatus,
            cancel_requested_at: null,
            deadline_expired: false,
            trigger_type: 'manual',
            graph_schema_version: 2,
            executable_schema_version: 3,
            executable_checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
          },
        ],
      };
    if (sql.includes('select completed_at, payload_checksum'))
      return {
        rows: [
          {
            payload_checksum: delivery.payloadChecksum,
            completed_at: new Date(),
          },
        ],
      };
    if (sql.includes('as high_water')) return { rows: [{ high_water: 1 }] };
    if (sql.includes('as fact_count'))
      return {
        rows: [
          { fact_count: 0, storage_bytes: '0', maximum_storage_bytes: '0' },
        ],
      };
    if (sql.includes('record_workflow_call_run_result')) {
      const reference = JSON.parse(String(values[3])) as { kind?: unknown };
      if (reference.kind === 'artifact') expect(values[6]).toBeNull();
      else expect(values[6]).toBe(serializedValue);
      expect(values[4]).toBe(valueIdentity.sha256);
      expect(values[5]).toBe(valueIdentity.byteLength);
    }
    return { rows: [], rowCount: this.fresh ? 1 : 0 };
  }
  public release(): void {
    this.releases += 1;
  }
}
function start(
  stop: boolean,
  wrongFingerprint = false,
  sourceMode?: 'run_input' | 'wrong_source',
  fresh = false,
  scope?: NativeCoordinatorResultPreparationScope,
  hydrate?: NativeCoordinatorResultSourceHydrator,
  prepareValue?: NativeCoordinatorResultValuePreparer,
  recoveryPlan = plan,
  recoveryDrift?: 'checkpoint' | 'version' | 'delivery',
) {
  const client = new ResultClient(
    stop,
    wrongFingerprint,
    sourceMode,
    fresh,
    recoveryPlan,
    recoveryDrift,
  );
  const pool = {
    options: { connectionTimeoutMillis: 100 },
    connect: (callback?: (error: undefined, client: PoolClient) => void) => {
      if (callback !== undefined)
        callback(undefined, client as unknown as PoolClient);
      return Promise.resolve(client as unknown as PoolClient);
    },
  } as unknown as Pool;
  const result = commitCoordinatorAdvancePlan(
    pool,
    {
      workspaceId: id(1),
      runId: id(2),
      workflowVersionId: id(3),
      delivery,
      plan: recoveryPlan,
      signal: new AbortController().signal,
    },
    {
      runTimeoutFailureContextEnabled: false,
      workspaceInboxProducerEnabled: false,
      workflowTriggerOutcomesEnabled: false,
      nativeValueControlReadTimeoutMillis: 250,
      inspectNativeResultOwner: () =>
        Promise.resolve({
          kind: 'active',
          databaseNow: '2026-10-04T00:00:00Z',
          deadlineAt: '2026-10-04T01:00:00Z',
        }),
      withNativeResultPreparation:
        scope ?? ((_input, prepare) => prepare(_input.signal)),
      ...(hydrate === undefined ? {} : { hydrateNativeResultSources: hydrate }),
      ...(prepareValue === undefined
        ? {}
        : { prepareNativeResultValue: prepareValue }),
    },
  );
  return { result, client };
}
async function execute(
  stop: boolean,
  wrongFingerprint = false,
  sourceMode?: 'run_input' | 'wrong_source',
  fresh = false,
) {
  const run = start(stop, wrongFingerprint, sourceMode, fresh);
  return { result: await run.result, client: run.client };
}
describe('native result precommit through actual tenant and CAS composition', () => {
  it.each(['exact', 'artifact_exact', 'substituted', 'aborted'] as const)(
    'prepares %s fresh result bytes inside the same independent S before the protected write',
    async (kind) => {
      const controller = new AbortController();
      let hydrated = false;
      let prepared = false;
      const operation = start(
        false,
        false,
        'run_input',
        true,
        (_request, prepare) => prepare(controller.signal),
        (request) => {
          expect(request.signal).toBe(controller.signal);
          hydrated = true;
          return Promise.resolve({
            runInput: { name: 'result' },
            nodeOutputs: {},
          });
        },
        (request) => {
          expect(client.releases).toBe(2);
          expect(request.signal).toBe(controller.signal);
          expect(hydrated).toBe(true);
          expect(request.owner).toMatchObject({
            kind: 'run_result',
            expectedRevision: 0,
            resultRevision: 1,
            delivery,
          });
          expect(request.owner.resultIdentity).toMatch(/^[0-9a-f]{64}$/u);
          expect(request.value).toEqual({ name: 'result' });
          expect(request.value).not.toBe(
            plan.callableResult?.kind === 'succeeded'
              ? plan.callableResult.value
              : undefined,
          );
          prepared = true;
          if (kind === 'aborted') controller.abort();
          return Promise.resolve({
            reference:
              kind === 'artifact_exact'
                ? { schemaVersion: 1, kind: 'artifact', artifactId: id(9) }
                : {
                    schemaVersion: 1,
                    kind: 'inline',
                    value: request.value,
                  },
            sha256:
              kind === 'substituted' ? 'b'.repeat(64) : valueIdentity.sha256,
            byteLength: valueIdentity.byteLength,
          });
        },
      );
      const client = operation.client;
      if (kind === 'exact' || kind === 'artifact_exact')
        await expect(operation.result).resolves.toMatchObject({
          kind: 'committed',
        });
      else await expect(operation.result).rejects.toBeInstanceOf(Error);
      expect(prepared).toBe(true);
      expect(
        client.sql.some((sql) =>
          sql.includes('record_workflow_call_run_result'),
        ),
      ).toBe(kind === 'exact' || kind === 'artifact_exact');
    },
  );
  it.each(['exact', 'changed'] as const)(
    'independently rehydrates %s pinned result material after SQL release, before any protected write',
    async (kind) => {
      let called = false;
      let scopeSignal: AbortSignal | undefined;
      const operation = start(
        false,
        false,
        'run_input',
        true,
        async (owner, prepare) => {
          scopeSignal = owner.signal;
          return prepare(owner.signal);
        },
        (request) => {
          called = true;
          expect(client.releases).toBe(2);
          expect(request.signal).toBe(scopeSignal);
          expect(request.owner).toMatchObject({
            workspaceId: id(1),
            runId: id(2),
            workflowVersionId: id(3),
            expectedRevision: 0,
            delivery,
          });
          expect(request.demand).toMatchObject({
            resultSelector: { kind: 'run_input', path: '$' },
            requiresRunInput: true,
            sources: [],
          });
          expect(
            client.sql.some((sql) =>
              sql.includes('record_workflow_call_run_result'),
            ),
          ).toBe(false);
          return Promise.resolve({
            runInput: { name: kind === 'exact' ? 'result' : 'changed' },
            nodeOutputs: {},
          });
        },
      );
      const client = operation.client;
      if (kind === 'exact')
        await expect(operation.result).resolves.toMatchObject({
          kind: 'committed',
        });
      else
        await expect(operation.result).rejects.toMatchObject({
          name: 'CoordinatorPlanInvalidError',
        });
      expect(called).toBe(true);
      expect(
        client.sql.some((sql) =>
          sql.includes('record_workflow_call_run_result'),
        ),
      ).toBe(kind === 'exact');
      expect(
        client.sql.some(
          (sql) =>
            sql.includes('load_native_coordinator_value_sources') ||
            sql.includes('read_native_coordinator_value_source'),
        ),
      ).toBe(false);
    },
  );
  it('does not enter final acceptance after scoped preparation loses its owner', async () => {
    const failure = new Error('owner lost during preparation');
    let joined = false;
    const { result, client } = start(
      false,
      false,
      'run_input',
      true,
      async (input, prepare) => {
        try {
          await prepare(input.signal);
          throw failure;
        } finally {
          joined = true;
        }
      },
    );
    await expect(result).rejects.toBe(failure);
    expect(joined).toBe(true);
    expect(
      client.sql.some(
        (sql) =>
          sql.includes('app.workflow_concurrency_protocol') ||
          sql.includes('record_workflow_call_run_result') ||
          sql.includes('update app.inbox_receipts'),
      ),
    ).toBe(false);
    expect(client.releases).toBe(2);
  });
  it('does not read payload or accept results after scope abort', async () => {
    const { result, client } = start(
      false,
      false,
      'run_input',
      true,
      (_input, prepare) => {
        const controller = new AbortController();
        controller.abort();
        return prepare(controller.signal);
      },
    );
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(
      client.sql.some(
        (sql) =>
          sql.includes('select version.executable_json') ||
          sql.includes('app.workflow_concurrency_protocol'),
      ),
    ).toBe(false);
    expect(client.releases).toBe(1);
  });
  it('records prepared original bytes after actual CAS and before receipt completion in the same transaction', async () => {
    const { result, client } = await execute(false, false, 'run_input', true);
    expect(result).toEqual({
      kind: 'committed',
      revision: 1,
      admittedAttempts: [],
    });
    const cas = client.sql.findIndex((sql) =>
      sql.includes('update app.run_checkpoints'),
    );
    const record = client.sql.findIndex((sql) =>
      sql.includes('record_workflow_call_run_result'),
    );
    const complete = client.sql.findIndex((sql) =>
      sql.includes('update app.inbox_receipts'),
    );
    expect(client.sql.indexOf('commit')).toBeLessThan(cas);
    expect(cas).toBeLessThan(record);
    expect(record).toBeLessThan(complete);
    expect(complete).toBeLessThan(client.sql.lastIndexOf('commit'));
  });
  it('prepares whole run input from independently accepted original bytes, never decoded run.input_ref', async () => {
    const { result, client } = await execute(false, false, 'run_input');
    expect(result).toEqual({ kind: 'already_committed', revision: 1 });
    expect(
      client.sql.filter((sql) =>
        sql.includes('load_native_coordinator_value_sources'),
      ),
    ).toHaveLength(1);
    expect(
      client.sql.filter((sql) =>
        sql.includes('read_native_coordinator_value_source'),
      ),
    ).toHaveLength(1);
    expect(
      client.sql
        .slice(0, client.sql.indexOf('commit'))
        .some(
          (sql) =>
            sql.includes('run.input_ref') ||
            sql.includes('workflow_call_result_value'),
        ),
    ).toBe(false);
    expect(client.releases).toBe(3);
  });
  it('rejects a substituted accepted source before opening the final writer', async () => {
    const { result, client } = start(false, false, 'wrong_source');
    await expect(result).rejects.toThrow();
    expect(
      client.sql.some((sql) =>
        sql.includes('app.workflow_concurrency_protocol'),
      ),
    ).toBe(false);
    expect(client.releases).toBe(2);
  });
  it('releases the bounded metadata-only literal read before entering the existing write/recovery owner', async () => {
    const { result, client } = await execute(false);
    expect(result).toEqual({ kind: 'already_committed', revision: 1 });
    expect(client.releases).toBe(3);
    const metadata = client.sql.findIndex((sql) =>
      sql.includes('select version.executable_json'),
    );
    const readCommit = client.sql.findIndex(
      (sql, index) => index > metadata && sql === 'commit',
    );
    const write = client.sql.findIndex((sql) =>
      sql.includes('app.workflow_concurrency_protocol'),
    );
    expect(metadata).toBeLessThan(readCommit);
    expect(readCommit).toBeLessThan(write);
    expect(client.sql[metadata]).not.toContain('run.input_ref');
    expect(
      client.sql.some((sql) => sql.includes('record_workflow_call_run_result')),
    ).toBe(false);
  });
  it('recovers exact full-plan CAS truth without any payload read after the current consumer stops', async () => {
    const { result, client } = await execute(true);
    expect(result).toEqual({ kind: 'already_committed', revision: 1 });
    expect(
      client.sql.some((sql) => sql.includes('select version.executable_json')),
    ).toBe(false);
    expect(
      client.sql.some((sql) =>
        sql.includes('read_native_coordinator_value_source'),
      ),
    ).toBe(false);
  });
  it('does not treat stopped inspection as an exact-recovery certificate', async () => {
    const { result } = await execute(true, true);
    expect(result).toEqual({ kind: 'stale', revision: 1 });
  });
  it.each([
    'exact',
    'fingerprint',
    'checkpoint',
    'version',
    'delivery',
  ] as const)(
    'keeps terminal artifact-bound ForEach lost-response recovery %s on the exact locked plan owner',
    async (kind) => {
      const rejectedPlan = parseTransitionPlan({
        expectedRevision: 0,
        expectedNextEventSequence: 2,
        consumedThroughEventSequence: 2,
        checkpoint: {
          ...checkpoint,
          runStatus: 'failed',
          nextEventSequence: 5,
          admittedInvocationKeys: ['loop'],
          invocations: [
            {
              invocationKey: 'loop',
              nodeId: 'loop',
              status: 'failed',
              attemptNumber: 1,
            },
          ],
        },
        events: [
          {
            schemaVersion: 1,
            sequence: 3,
            name: 'node.failed',
            invocationKey: 'loop',
            nodeId: 'loop',
            attemptNumber: 1,
            reasonCode: 'loop_limit_exceeded',
            occurredAt: '2026-10-04T00:00:00.000Z',
          },
          {
            schemaVersion: 1,
            sequence: 4,
            name: 'run.failed',
            occurredAt: '2026-10-04T00:00:00.000Z',
          },
        ],
        nodeRunAdmissions: [],
        attempts: [],
      });
      let valueWork = false;
      const operation = start(
        true,
        kind === 'fingerprint',
        undefined,
        false,
        () => {
          valueWork = true;
          throw new Error('Terminal value work is forbidden');
        },
        undefined,
        undefined,
        rejectedPlan,
        kind === 'checkpoint' || kind === 'version' || kind === 'delivery'
          ? kind
          : undefined,
      );
      if (kind === 'exact')
        await expect(operation.result).resolves.toEqual({
          kind: 'already_committed',
          revision: 1,
        });
      else if (kind === 'fingerprint' || kind === 'checkpoint')
        await expect(operation.result).resolves.toEqual({
          kind: 'stale',
          revision: 1,
        });
      else await expect(operation.result).rejects.toThrow();
      expect(valueWork).toBe(false);
      expect(
        operation.client.sql.some(
          (sql) =>
            sql.includes('load_native_coordinator_control_sources') ||
            sql.includes('read_native_coordinator_control_source') ||
            sql.includes('lock_native_coordinator_control_sources'),
        ),
      ).toBe(false);
    },
  );
});
