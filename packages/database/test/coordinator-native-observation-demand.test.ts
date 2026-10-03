import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { loadCoordinatorAdvanceState } from '../src/execution/coordinator/coordinator-run-store-observations.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const workflowVersionId = '33333333-3333-4333-8333-333333333333';

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
  function queryResult(sql: string) {
    if (sql.includes("set_config('app.workspace_id'")) scoped = true;
    if (sql === 'commit' || sql === 'rollback') scoped = false;
    if (sql.includes("current_setting('app.workspace_id'"))
      return {
        rows: [
          {
            workspace_id: scoped ? workspaceId : null,
            actor_id: null,
            discovery_scope: null,
            statement_timeout_millis: 0,
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
  const query = vi.fn((sql: string) => Promise.resolve(queryResult(sql)));
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn(() => Promise.resolve(client));
  const pool = { connect } as unknown as Pool;
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
          workflowCalls: { declarations: [], facts: [] },
        },
      });
      if (result.kind !== 'ready') throw new Error('Expected ready state');
      expect(result.state).not.toHaveProperty('callableCompletion');
      expect(source.decodeInput).not.toHaveBeenCalled();
      expect(
        source.query.mock.calls.some(([sql]) =>
          sql.includes('app.read_native_workflow_attempt_output'),
        ),
      ).toBe(false);
      expect(source.connect).toHaveBeenCalledOnce();
      expect(source.release).toHaveBeenCalledExactlyOnceWith();
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
      const result = await loadCoordinatorAdvanceState(source.pool, {
        workspaceId,
        runId,
        signal: new AbortController().signal,
      });
      expect(result).toMatchObject({
        kind: 'ready',
        state: { checkpoint: source.checkpoint },
      });
      if (result.kind !== 'ready')
        throw new Error('Expected controlled ready state');
      expect(result.state).not.toHaveProperty('callableCompletion');
      expect(source.decodeInput).not.toHaveBeenCalled();
      expect(source.release).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it('preserves callable declaration validation without decoding selected input', async () => {
    const source = adapter({ kind: 'run_input', path: '$' });
    source.callable.schemaVersion = 99;
    await expect(
      loadCoordinatorAdvanceState(source.pool, {
        workspaceId,
        runId,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(source.decodeInput).not.toHaveBeenCalled();
    expect(source.query.mock.calls.map(([sql]) => sql)).toContain('rollback');
    expect(source.release).toHaveBeenCalledExactlyOnceWith();
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
    expect(source.release).toHaveBeenCalledExactlyOnceWith();
  });
});
