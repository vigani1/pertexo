import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';
import { prepareCoordinatorControls } from '../src/execution/coordinator/coordinator-control-preparation.js';
import { CallableCompletionStoppedError } from '@pertexo/workflow-model/workflow-call-contract';
import {
  nativeCoordinatorControlFixture as fixture,
  nativeControlId as id,
} from './support/coordinator-native-control.fixture.js';

/** External pg seam only; no protected SQL execution or authority qualification. */
function preparationFixture(stopped = false) {
  const f = fixture();
  const owner = {
    workspaceId: id(1),
    runId: id(2),
    workflowVersionId: id(3),
    expectedRevision: 4,
    delivery: { outboxEventId: id(4), payloadChecksum: 'a'.repeat(64) },
  };
  class Client extends EventEmitter {
    releases = 0;
    workspace: string | null = null;
    timeout = 0;
    statements: string[] = [];
    async query(sql: string, values: unknown[] = []) {
      await Promise.resolve();
      this.statements.push(sql);
      if (sql.includes("set_config('app.workspace_id'"))
        this.workspace = String(values[0]);
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
      if (sql.includes('select checkpoint.scheduler_state'))
        return {
          rows: [
            {
              scheduler_state: structuredClone(f.material.checkpoint),
              executable_json: structuredClone(f.material.executable),
            },
          ],
        };
      if (sql.includes('as fact_count'))
        return {
          rows: [
            {
              fact_count: 1,
              storage_bytes: '400',
              maximum_storage_bytes: '400',
            },
          ],
        };
      if (sql.includes('select event.sequence'))
        return {
          rows: [
            {
              sequence: 5,
              type: 'node.succeeded',
              created_at: new Date('2026-10-04T00:00:00.000Z'),
              payload: {
                schemaVersion: 1,
                invocationKey: 'loop',
                nodeId: 'loop',
                attemptId: id(5),
                nodeRunId: id(9),
                attemptNumber: 1,
              },
            },
          ],
        };
      if (sql.includes('select attempt.id as attempt_id'))
        return {
          rows: [
            {
              attempt_id: id(5),
              attempt_number: 1,
              attempt_status: 'succeeded',
              attempt_output_ref: {
                schemaVersion: 1,
                kind: 'artifact',
                artifactId: id(6),
              },
              executor_failure_kind: null,
              node_output_ref: {
                schemaVersion: 1,
                kind: 'artifact',
                artifactId: id(6),
              },
              invocation_key: 'loop',
              node_run_id: id(9),
              node_id: 'loop',
              current_attempt_id: id(5),
              node_status: 'succeeded',
              resume_at: null,
              retry_due_at: null,
              retry_decision: null,
              wait_kind: null,
            },
          ],
        };
      if (sql.includes('load_native_coordinator_control_sources')) {
        expect(JSON.parse(String(values[0]))).toEqual(owner);
        expect(values[1]).toBe(5);
        return {
          rows: [
            {
              result: stopped
                ? {
                    kind: 'stopped',
                    stop: { kind: 'unavailable', reason: 'source_read_failed' },
                  }
                : {
                    kind: 'ready',
                    projection: structuredClone(f.material.sources),
                  },
            },
          ],
        };
      }
      return { rows: [] };
    }
    release() {
      this.releases++;
    }
  }
  const client = new Client();
  const pool = {
    options: { connectionTimeoutMillis: 100 },
    connect: (callback?: (error: undefined, client: PoolClient) => void) => {
      const external = client as unknown as PoolClient;
      callback?.(undefined, external);
      return Promise.resolve(external);
    },
  } as unknown as Pool;
  const signal = new AbortController().signal;
  const hydrate = vi.fn(({ signal: actual }: { signal: AbortSignal }) => {
    expect(client.releases).toBeGreaterThan(0);
    expect(client.workspace).toBeNull();
    expect(actual).toBe(signal);
    return Promise.resolve(structuredClone(f.value));
  });
  const prepare = () =>
    prepareCoordinatorControls(pool, {
      owner,
      plan: f.plan,
      signal,
      readTimeoutMillis: 250,
      hydrate,
    });
  return { ...f, client, hydrate, prepare };
}

it('freshly reads needed facts/pins/original descriptors and releases SQL before independent precommit hydration', async () => {
  const f = preparationFixture();
  const first = await f.prepare();
  const second = await f.prepare();
  expect(first).toEqual(second);
  expect(second).not.toBe(first);
  expect(first.sources).toEqual(f.material.sources);
  expect(first.collections).toEqual([
    {
      invocationKey: 'loop',
      collectionSize: 1,
      collectionChecksum: f.plan.checkpoint.loops[0]?.collectionChecksum,
    },
  ]);
  expect(f.hydrate).toHaveBeenCalledTimes(2);
  expect(f.client.releases).toBe(2);
  expect(
    f.client.statements.filter((sql) =>
      sql.includes('load_native_coordinator_control_sources'),
    ),
  ).toHaveLength(2);
  expect(
    f.client.statements.some(
      (sql) => sql.includes('for update') || sql.includes('for no key update'),
    ),
  ).toBe(false);
});

it('does not reuse first-pass semantics when independent fresh bytes differ', async () => {
  const f = preparationFixture();
  f.hydrate.mockResolvedValueOnce({ items: ['different'], iterationCount: 1 });
  await expect(f.prepare()).rejects.toThrow();
  expect(f.client.releases).toBe(1);
});

it('maps a typed actual metadata stop through the shared constructor and joins read disposal before returning', async () => {
  const f = preparationFixture(true);
  await expect(f.prepare()).rejects.toBeInstanceOf(
    CallableCompletionStoppedError,
  );
  expect(f.hydrate).not.toHaveBeenCalled();
  expect(f.client.releases).toBe(1);
});
