import type { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { loadCoordinatorAdvanceState } from '../src/execution/coordinator/coordinator-run-store-observations.js';
import { parseCoordinatorExecutableCapability } from '../src/execution/coordinator/coordinator-executable-capability.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const workflowVersionId = '33333333-3333-4333-8333-333333333333';
const delivery = {
  outboxEventId: '44444444-4444-4444-8444-444444444444',
  payloadChecksum: 'a'.repeat(64),
};
const call = { key: 'core.workflow_call', version: 1 };
const policy = { key: 'workflow.call', version: 1 };
const catalogJson = JSON.stringify({
  domain: 'pertexo.node-compatibility-release',
  schemaVersion: 1,
  policies: [
    ['engine.scheduler', 2],
    ['engine.checkpoint', 2],
    ['engine.retry', 1],
    ['engine.timeout', 2],
    ['engine.cancellation', 2],
  ]
    .map(([key, version]) => ({ key, version }))
    .concat([policy]),
  definitions: [
    {
      definition: call,
      executor: call,
      executorAbi: 1,
      lifecycle: 'active',
      policyReferences: [policy],
    },
  ],
  executors: [
    {
      executor: call,
      abiVersion: 1,
      lifecycle: 'active',
      definitions: [call],
      policyReferences: [policy],
    },
  ],
});
const nativeRelease = {
  epoch: 1,
  fingerprint: `node-compat:v1:sha256:${createHash('sha256').update(catalogJson).digest('hex')}`,
  catalogJson,
};
const nativeAdapter = {
  controlReadTimeoutMillis: 250,
  capability: parseCoordinatorExecutableCapability([nativeRelease]),
};
const request = () => ({
  workspaceId,
  runId,
  delivery,
  signal: new AbortController().signal,
});

function adapter(selector: unknown, native = true) {
  const format = native ? 3 : 2;
  const checkpoint = {
    schemaVersion: native ? 3 : 1,
    engineVersion: native ? 'engine-v3' : 'engine-v1',
    workflowVersionId,
    revision: 0,
    runStatus: 'running',
    nextEventSequence: 1,
    readySet: [],
    admittedInvocationKeys: [],
    invocations: [],
    joins: [],
    loops: [],
    remainingIterationBudget: 1_000,
    cancelRequested: false,
    deadlineExpired: false,
    ...(native ? { calls: [], branchSelections: [] } : {}),
  };
  const callable = {
    schemaVersion: 1,
    input: { type: 'object', properties: {}, required: [] },
    result: { type: 'object', properties: {}, required: [] },
    resultSelector: selector,
  };
  const decodeInput = vi.fn(() => {
    throw new Error('Native result input was decoded before engine demand');
  });
  const inputRef = {
    schemaVersion: 1,
    kind: 'inline',
    get value(): unknown {
      return decodeInput();
    },
  };
  let scoped = false;
  let timeout = 0;
  function queryResult(sql: string, values: unknown[] = []) {
    if (sql.includes("set_config('app.workspace_id'")) scoped = true;
    if (sql.includes("set_config('statement_timeout'"))
      timeout = Number.parseInt(String(values[0]), 10);
    if (sql === 'commit' || sql === 'rollback') {
      scoped = false;
      timeout = 0;
    }
    if (sql.includes("current_setting('app.workspace_id'"))
      return {
        rows: [
          {
            workspace_id: scoped ? workspaceId : null,
            actor_id: null,
            discovery_scope: null,
            statement_timeout_millis: timeout,
          },
        ],
      };
    if (sql.includes('select version.schema_version as graph_schema_version'))
      return {
        rows: [
          {
            graph_schema_version: native ? 2 : 1,
            executable_schema_version: format,
            executable_checksum: `wf:v${String(format)}:sha256:${'a'.repeat(64)}`,
          },
        ],
      };
    if (sql.includes('app.inspect_native_coordinator_value_owner'))
      return {
        rows: [
          {
            result: checkpoint.cancelRequested
              ? { kind: 'stopped', stop: { kind: 'canceled' } }
              : checkpoint.deadlineExpired
                ? { kind: 'stopped', stop: { kind: 'timed_out' } }
                : {
                    kind: 'active',
                    databaseNow: '2026-10-04T00:00:00Z',
                    deadlineAt: '2026-10-04T01:00:00Z',
                  },
          },
        ],
      };
    if (sql.includes('run.id as run_id'))
      return {
        rows: [
          {
            run_id: runId,
            workflow_version_id: workflowVersionId,
            status: checkpoint.runStatus,
            cancel_requested_at: checkpoint.cancelRequested
              ? new Date('2026-10-03T23:59:00.000Z')
              : null,
            deadline_at: checkpoint.deadlineExpired
              ? new Date('2026-10-03T23:59:00.000Z')
              : null,
            database_now: new Date('2026-10-04T00:00:00.000Z'),
            revision: 0,
            engine_version: checkpoint.engineVersion,
            scheduler_state: checkpoint,
            executable_schema_version: format,
            graph_schema_version: native ? 2 : 1,
            executable_checksum: `wf:v${String(format)}:sha256:${'a'.repeat(64)}`,
            executable_json: {
              schemaVersion: format,
              compatibilityReleaseEpoch: nativeRelease.epoch,
              compatibilityReleaseFingerprint: nativeRelease.fingerprint,
              graph: {
                nodes: [
                  {
                    id: 'result',
                    definition: { key: 'core.manual', version: 1 },
                  },
                ],
                ...(native ? { callable } : {}),
              },
            },
            input_ref: inputRef,
            event_high_water: 0,
          },
        ],
      };
    if (sql.includes('count(*)::int as fact_count'))
      return {
        rows: [
          { fact_count: 0, storage_bytes: '0', maximum_storage_bytes: '0' },
        ],
      };
    if (
      sql.includes('app.read_native_workflow_attempt_output') ||
      sql.includes('app.read_workflow_call_result_reference')
    )
      throw new Error(
        'Native source material query occurred before engine demand',
      );
    return { rows: [] };
  }
  const query = vi.fn((sql: string, values?: unknown[]) =>
    Promise.resolve(queryResult(sql, values)),
  );
  const release = vi.fn();
  const client = Object.assign(new EventEmitter(), {
    query,
    release,
  }) as unknown as PoolClient;
  const connect = vi.fn(
    (callback?: (error: undefined, client: PoolClient) => void) => {
      if (callback === undefined) return Promise.resolve(client);
      callback(undefined, client);
      return undefined;
    },
  );
  const pool = {
    connect,
    options: { connectionTimeoutMillis: 100 },
  } as unknown as Pool;
  return { pool, query, release, connect, decodeInput, callable, checkpoint };
}

describe('actual coordinator observation read adapter before native demand', () => {
  it.each([
    { kind: 'run_input', path: '$' },
    { kind: 'node_output', nodeId: 'result', path: '$' },
    {
      kind: 'expression',
      language: 'jsonata',
      policyVersion: 1,
      expression: 'nodeOutputs.result',
    },
    { kind: 'literal', value: {} },
  ])(
    'does not fetch or decode callable result material for $kind',
    async (selector) => {
      const source = adapter(selector);
      const result = await loadCoordinatorAdvanceState(
        source.pool,
        request(),
        nativeAdapter,
      );
      expect(result).toMatchObject({
        kind: 'ready',
        state: {
          checkpoint: source.checkpoint,
          observations: [],
          controlDeclarations: { lastSequence: 0, identities: [] },
          workflowCalls: { declarations: [], facts: [] },
        },
      });
      if (result.kind !== 'ready') throw new Error('Expected ready state');
      expect(result.state).not.toHaveProperty('callableCompletion');
      expect(result.state).not.toHaveProperty('completedOutputs');
      expect(source.decodeInput).not.toHaveBeenCalled();
      expect(
        source.query.mock.calls.some(([sql]) =>
          sql.includes('app.read_native_workflow_attempt_output'),
        ),
      ).toBe(false);
      expect(source.connect).toHaveBeenCalledTimes(2);
      expect(source.release).toHaveBeenCalledTimes(2);
      expect(source.query.mock.calls.map(([sql]) => sql)).toContain(
        'begin isolation level repeatable read read only',
      );
      expect(source.query.mock.calls.map(([sql]) => sql)).toContain('commit');
      expect(
        source.query.mock.calls.find(([sql]) =>
          sql.includes('run.id as run_id'),
        )?.[0],
      ).not.toContain('run.input_ref');
    },
  );

  it.each(['canceled', 'timed_out'] as const)(
    'retains actual validated %s controls without callable material',
    async (kind) => {
      const source = adapter({
        kind: 'node_output',
        nodeId: 'result',
        path: '$',
      });
      source.checkpoint.cancelRequested = kind === 'canceled';
      source.checkpoint.deadlineExpired = kind === 'timed_out';
      const result = await loadCoordinatorAdvanceState(
        source.pool,
        request(),
        nativeAdapter,
      );
      expect(result).toMatchObject({
        kind: 'ready',
        state: { checkpoint: source.checkpoint },
      });
      if (result.kind !== 'ready')
        throw new Error('Expected controlled ready state');
      expect(result.state).not.toHaveProperty('callableCompletion');
      expect(source.decodeInput).not.toHaveBeenCalled();
      expect(source.release).toHaveBeenCalledTimes(2);
    },
  );

  it('preserves callable declaration validation without decoding selected input', async () => {
    const source = adapter({ kind: 'run_input', path: '$' });
    source.callable.schemaVersion = 99;
    await expect(
      loadCoordinatorAdvanceState(source.pool, request(), nativeAdapter),
    ).rejects.toThrow();
    expect(source.decodeInput).not.toHaveBeenCalled();
    expect(source.query.mock.calls.map(([sql]) => sql)).toContain('rollback');
    expect(source.release).toHaveBeenCalledTimes(2);
  });

  it('preserves the retained observation path and tenant cleanup', async () => {
    const source = adapter(undefined, false);
    const result = await loadCoordinatorAdvanceState(source.pool, {
      workspaceId,
      runId,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      kind: 'ready',
      state: {
        checkpoint: source.checkpoint,
        observations: [],
        completedOutputs: [],
      },
    });
    if (result.kind !== 'ready')
      throw new Error('Expected retained ready state');
    expect(result.state).not.toHaveProperty('workflowCalls');
    expect(result.state).not.toHaveProperty('callableCompletion');
    expect(source.release).toHaveBeenCalledTimes(2);
  });
  it('refuses native format in a retained-only adapter before executable or fact payload reads', async () => {
    const source = adapter({ kind: 'literal', value: {} });
    await expect(
      loadCoordinatorAdvanceState(source.pool, request()),
    ).resolves.toEqual({ kind: 'not_executable' });
    expect(
      source.query.mock.calls.some(
        ([sql]) =>
          sql.includes('run.id as run_id') ||
          sql.includes('app.read_workflow_call'),
      ),
    ).toBe(false);
    expect(source.decodeInput).not.toHaveBeenCalled();
    expect(source.connect).toHaveBeenCalledOnce();
  });
  it('refuses incompatible actual shared K before any native classifier checkout', async () => {
    const source = adapter({ kind: 'literal', value: {} });
    source.pool.options.connectionTimeoutMillis = 5_000;
    await expect(
      loadCoordinatorAdvanceState(source.pool, request(), nativeAdapter),
    ).rejects.toThrow('Actual shared pool');
    expect(source.connect).not.toHaveBeenCalled();
  });
});
