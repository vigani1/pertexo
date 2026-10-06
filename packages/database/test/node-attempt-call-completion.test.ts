import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { completeNodeAttempt } from '../src/execution/node-attempts/node-attempt-run-store-completion.js';
import { canonicalOutboxPayloadChecksum } from '../src/execution/transport/outbox.js';
import type { NodeAttemptLease } from '../src/execution/node-attempts/node-attempt-run-store-contract.js';

// External pg boundary only: completion and tenant transactions are real.
const query = vi.fn();
const release = vi.fn();
const id = (n: number) =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const payload = {
  schemaVersion: 1,
  workspaceId: id(1),
  runId: id(2),
  nodeRunId: id(4),
  attemptId: id(5),
  outboxEventId: id(6),
};
const checksum = canonicalOutboxPayloadChecksum(payload);
const lease: NodeAttemptLease = {
  workspaceId: id(1),
  runId: id(2),
  workflowVersionId: id(3),
  nodeRunId: id(4),
  attemptId: id(5),
  attemptNumber: 1,
  admissionKind: 'execute',
  invocationKey: `${id(3)}|call|b:|i:`,
  nodeId: 'call',
  workerId: 'worker-1',
  sideEffectClass: 'unsafe',
  fenceToken: 1,
  leaseExpiresAt: new Date(Date.now() + 60000),
  delivery: { outboxEventId: id(6), payloadChecksum: checksum },
};
const rawReference =
  '{"kind":"inline","schemaVersion":1,"value":9007199254740993}';
let client: PoolClient;
const pool = {
  connect: () => Promise.resolve(client),
} as unknown as Pool;
let completed = false;
beforeEach(() => {
  vi.clearAllMocks();
  completed = false;
  const emitter = new EventEmitter();
  client = Object.assign(emitter, { query, release }) as unknown as PoolClient;
  release.mockImplementation((destroy?: Error | boolean) => {
    if (destroy) emitter.emit('end');
  });
  let workspaceId: string | null = null;
  query.mockImplementation((sql: string, values?: unknown[]) => {
    if (sql.includes("set_config('app.workspace_id'")) {
      workspaceId = values?.[0] as string;
    }
    if (sql.includes('current_setting'))
      return Promise.resolve({
        rows: [
          { workspace_id: workspaceId, actor_id: null, discovery_scope: null },
        ],
      });
    if (sql === 'commit' || sql === 'rollback') workspaceId = null;
    if (sql.includes('select aggregate_id'))
      return Promise.resolve({
        rows: [
          {
            aggregate_id: id(5),
            aggregate_type: 'node-attempt',
            job_name: 'execute-node-attempt',
            payload,
            payload_checksum: checksum,
            schema_version: 1,
          },
        ],
      });
    if (sql.includes('select completed_at,payload_checksum'))
      return Promise.resolve({
        rows: [
          {
            completed_at: completed ? new Date() : null,
            payload_checksum: checksum,
          },
        ],
      });
    if (sql.includes('abort_requested') || sql.includes(') native_execution'))
      return Promise.resolve({
        rowCount: 1,
        rows: [
          {
            abort_requested: false,
            native_execution: true,
            physical_completion_recorded: completed,
          },
        ],
      });
    if (sql.includes('select attempt.status'))
      return Promise.resolve({
        rows: [
          {
            attempt_status: completed ? 'succeeded' : 'running',
            current_attempt: true,
            fence_token: '1',
            lease_owner: completed ? null : 'worker-1',
            lease_expires_at: completed ? null : lease.leaseExpiresAt,
            lease_valid: !completed,
            output_ref: completed
              ? (JSON.parse(rawReference) as unknown)
              : null,
            safe_error_code: null,
            error_summary: null,
            executor_failure_kind: null,
            executor_error_kind: null,
            executor_possibly_dispatched: null,
            retry_decision: null,
            node_status: completed ? 'waiting' : 'running',
            wait_kind: completed ? 'workflow_call' : null,
            suspension_recorded: false,
          },
        ],
      });
    if (sql.includes('workflow_call_declaration_completion_reference'))
      return Promise.resolve({ rows: [{ reference: rawReference }] });
    if (sql.includes('coalesce(max(sequence)'))
      return Promise.resolve({ rows: [{ sequence: 1 }] });
    return Promise.resolve({ rowCount: 1, rows: [] });
  });
});
const complete = () =>
  completeNodeAttempt(
    pool,
    {
      lease,
      outcome: { status: 'succeeded', output: null },
      signal: new AbortController().signal,
    },
    'workflow_call_input_alias',
  );

describe('native Call completion through real tenant owner (external pg, not SQL authority proof)', () => {
  it('aliases the original projection into physical attempt and node without a driver roundtrip', async () => {
    await expect(complete()).resolves.toMatchObject({ kind: 'committed' });
    const attemptWrite = query.mock.calls.find(([sql]) =>
      (sql as string).includes('update app.node_attempts'),
    );
    const nodeWrite = query.mock.calls.find(([sql]) =>
      (sql as string).includes('update app.node_runs'),
    );
    expect((attemptWrite?.[1] as unknown[])[3]).toBe(rawReference);
    expect((nodeWrite?.[1] as unknown[])[3]).toBe(rawReference);
    expect(
      query.mock.calls.some(([sql]) =>
        (sql as string).includes('insert into app.run_events'),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([sql]) =>
        (sql as string).includes('insert into app.outbox_events'),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([sql]) =>
        (sql as string).includes('update app.inbox_receipts'),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([sql]) =>
        (sql as string).includes('record_native_workflow_attempt_output'),
      ),
    ).toBe(false);
    const statements = query.mock.calls.map(([sql]) => sql as string);
    const alias = statements.findIndex((sql) =>
      sql.includes('workflow_call_declaration_completion_reference'),
    );
    const receipt = statements.findIndex((sql) =>
      sql.includes('select completed_at,payload_checksum'),
    );
    const run = statements.findIndex((sql) => sql.includes('abort_requested'));
    const attempt = statements.findIndex((sql) =>
      sql.includes('select attempt.status'),
    );
    expect(alias).toBeGreaterThan(-1);
    expect(receipt).toBeGreaterThan(alias);
    expect(run).toBeGreaterThan(receipt);
    expect(attempt).toBeGreaterThan(run);
    expect(statements).toContain('commit');
    expect(statements).not.toContain('rollback');
    expect(release.mock.calls).toEqual([[]]);
  });
  it('records an ordinary native output before the first physical write', async () => {
    await expect(
      completeNodeAttempt(pool, {
        lease: {
          ...lease,
          nodeId: 'ordinary',
          invocationKey: 'ordinary',
          sideEffectClass: 'safe',
        },
        outcome: { status: 'succeeded', output: { name: 'ordinary' } },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'committed' });
    const recordIndex = query.mock.calls.findIndex(([sql]) =>
      (sql as string).includes('record_native_workflow_attempt_output'),
    );
    const updateIndex = query.mock.calls.findIndex(([sql]) =>
      (sql as string).includes('update app.node_attempts'),
    );
    expect(recordIndex).toBeGreaterThan(-1);
    expect(updateIndex).toBeGreaterThan(recordIndex);
    const statements = query.mock.calls.map(([sql]) => sql as string);
    const prelock = statements.findIndex((sql) =>
      sql.includes('prelock_native_attempt_value_owner'),
    );
    expect(prelock).toBeGreaterThan(-1);
    expect(prelock).toBeLessThan(
      statements.findIndex((sql) =>
        sql.includes('select completed_at,payload_checksum'),
      ),
    );
    expect(statements[prelock]).not.toContain('coordinator');
  });
  it.each(['denial', 'cancellation'] as const)(
    'starts no descendant SQL after native prelock %s',
    async (stop) => {
      const controller = new AbortController();
      const original = query.getMockImplementation();
      query.mockImplementation((sql: string, values?: unknown[]): unknown => {
        if (sql.includes('prelock_native_attempt_value_owner')) {
          if (stop === 'cancellation') controller.abort();
          return stop === 'denial'
            ? Promise.reject(new Error('prelock denied'))
            : Promise.resolve({ rows: [] });
        }
        return original?.(sql, values);
      });
      await expect(
        completeNodeAttempt(pool, {
          lease,
          outcome: { status: 'succeeded', output: null },
          signal: controller.signal,
        }),
      ).rejects.toThrow();
      const statements = query.mock.calls.map(([sql]) => sql as string);
      const prelock = statements.findIndex((sql) =>
        sql.includes('prelock_native_attempt_value_owner'),
      );
      const cleanup = statements.slice(prelock + 1);
      if (stop === 'denial') {
        expect(cleanup).toHaveLength(2);
        expect(cleanup[0]).toBe('rollback');
        expect(cleanup[1]).toContain(
          "select current_setting('app.workspace_id'",
        );
      } else expect(cleanup).toEqual([]);
    },
  );
  it('does not record physical output when the current lease fence is lost', async () => {
    await expect(
      completeNodeAttempt(pool, {
        lease: { ...lease, fenceToken: 2 },
        outcome: { status: 'succeeded', output: { name: 'ordinary' } },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(
      query.mock.calls.some(([sql]) =>
        (sql as string).includes('record_native_workflow_attempt_output'),
      ),
    ).toBe(false);
  });
  it('does not write physical state after native provenance denial', async () => {
    const original = query.getMockImplementation();
    query.mockImplementation((sql: string, values?: unknown[]): unknown =>
      sql.includes('record_native_workflow_attempt_output')
        ? Promise.reject(new Error('protected output denied'))
        : original?.(sql, values),
    );
    await expect(
      completeNodeAttempt(pool, {
        lease,
        outcome: { status: 'succeeded', output: { name: 'ordinary' } },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('protected output denied');
    expect(
      query.mock.calls.some(([sql]) =>
        (sql as string).includes('update app.node_attempts'),
      ),
    ).toBe(false);
  });
  it('uses sealed physical replay even after the coordinator makes the logical node wait', async () => {
    completed = true;
    await expect(complete()).resolves.toEqual({
      kind: 'duplicate',
      outboxEventId: null,
    });
    expect(
      query.mock.calls.some(([sql]) => (sql as string).startsWith('update ')),
    ).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql === 'commit')).toBe(true);
    expect(release.mock.calls).toEqual([[]]);
  });
  it('propagates protected alias denial without any physical output write', async () => {
    const original = query.getMockImplementation();
    query.mockImplementation((sql: string, values?: unknown[]): unknown =>
      sql.includes('workflow_call_declaration_completion_reference')
        ? Promise.reject(new Error('protected alias denied'))
        : original?.(sql, values),
    );
    await expect(complete()).rejects.toThrow('protected alias denied');
    expect(
      query.mock.calls.some(([sql]) =>
        (sql as string).includes('update app.node_attempts'),
      ),
    ).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql === 'rollback')).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql === 'commit')).toBe(false);
    expect(release.mock.calls).toEqual([[]]);
  });
});
