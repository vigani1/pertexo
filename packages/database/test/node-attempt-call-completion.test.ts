import type { Pool, PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as transactions from '../src/execution/node-attempts/node-attempt-run-store-transactions.js';
import { completeNodeAttempt } from '../src/execution/node-attempts/node-attempt-run-store-completion.js';
import { canonicalOutboxPayloadChecksum } from '../src/execution/transport/outbox.js';
import type { NodeAttemptLease } from '../src/execution/node-attempts/node-attempt-run-store-contract.js';

const { query, transaction } = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock(
  '../src/execution/node-attempts/node-attempt-run-store-transactions.js',
  async (original) => ({
    ...(await original<typeof transactions>()),
    withWorkspaceWriteClient: transaction,
  }),
);
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
const pool = {} as Pool;
let completed = false;
beforeEach(() => {
  vi.clearAllMocks();
  completed = false;
  transaction.mockImplementation(
    (
      _pool: Pool,
      _workspace: string,
      _signal: AbortSignal,
      operation: (client: PoolClient) => Promise<unknown>,
    ) => operation({ query } as unknown as PoolClient),
  );
  query.mockImplementation((sql: string) => {
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
    if (sql.includes('abort_requested'))
      return Promise.resolve({
        rowCount: 1,
        rows: [{ abort_requested: false, native_execution: true }],
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

describe('native Call completion through existing owner (mocked SQL, not authority proof)', () => {
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
  });
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
    query.mockImplementation((sql: string): unknown =>
      sql.includes('record_native_workflow_attempt_output')
        ? Promise.reject(new Error('protected output denied'))
        : original?.(sql),
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
  });
  it('propagates protected alias denial without any physical output write', async () => {
    const original = query.getMockImplementation();
    query.mockImplementation((sql: string): unknown =>
      sql.includes('workflow_call_declaration_completion_reference')
        ? Promise.reject(new Error('protected alias denied'))
        : original?.(sql),
    );
    await expect(complete()).rejects.toThrow('protected alias denied');
    expect(
      query.mock.calls.some(([sql]) =>
        (sql as string).includes('update app.node_attempts'),
      ),
    ).toBe(false);
  });
});
