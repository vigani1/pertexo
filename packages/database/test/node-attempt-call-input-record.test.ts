import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type * as transactions from '../src/execution/node-attempts/node-attempt-run-store-transactions.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeAttemptLease } from '../src/execution/node-attempts/node-attempt-run-store-contract.js';
import {
  readWorkflowCallDeclarationInput,
  recordWorkflowCallDeclarationInput,
} from '../src/execution/node-attempts/node-attempt-call-input-record.js';

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
  workerId: 'new-worker',
  sideEffectClass: 'unsafe',
  fenceToken: 2,
  leaseExpiresAt: new Date(Date.now() + 60_000),
  delivery: { outboxEventId: id(6), payloadChecksum: 'b'.repeat(64) },
};
const value = { name: 'input' };
const canonical = JSON.stringify(value);
const snapshot = {
  reference: { schemaVersion: 1 as const, kind: 'inline' as const, value },
  sha256: createHash('sha256').update(canonical).digest('hex'),
  byteLength: Buffer.byteLength(canonical),
};
const persistedSnapshot = { ...snapshot, serializedValue: canonical };
const pool = {} as Pool;
const signal = new AbortController().signal;
beforeEach(() => {
  vi.clearAllMocks();
  transaction.mockImplementation(
    (
      _pool: Pool,
      _workspace: string,
      _signal: AbortSignal,
      operation: (client: PoolClient) => Promise<unknown>,
    ) => operation({ query } as unknown as PoolClient),
  );
  query.mockResolvedValue({ rows: [] });
});
describe('required Call input SQL adapter (mocked client, not authority proof)', () => {
  it('passes narrow current authority and canonical bytes through the existing tenant owner', async () => {
    await recordWorkflowCallDeclarationInput(pool, {
      lease,
      ...snapshot,
      signal,
    });
    expect(transaction).toHaveBeenCalledWith(
      pool,
      lease.workspaceId,
      signal,
      expect.any(Function),
    );
    expect(query.mock.calls[0]?.[0]).toContain('lock_workspace_run_admission');
    const args = query.mock.calls[1]?.[1] as unknown[];
    const authority = JSON.parse(args[0] as string) as Record<string, unknown>;
    expect(authority.fenceToken).toBe(2);
    expect(authority.workerId).toBe('new-worker');
    expect(authority.delivery).toEqual(lease.delivery);
    expect(authority).not.toHaveProperty('leaseExpiresAt');
    expect(args.slice(2)).toEqual([
      snapshot.sha256,
      snapshot.byteLength,
      canonical,
    ]);
  });
  it('rejects incorrect inline metadata before opening a transaction', async () => {
    await expect(
      recordWorkflowCallDeclarationInput(pool, {
        lease,
        ...snapshot,
        sha256: 'f'.repeat(64),
        signal,
      }),
    ).rejects.toThrow('metadata does not match');
    expect(transaction).not.toHaveBeenCalled();
  });
  it('returns the exact committed snapshot under current authority', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ snapshot: persistedSnapshot }] });
    await expect(
      readWorkflowCallDeclarationInput(pool, { lease, signal }),
    ).resolves.toEqual(persistedSnapshot);
    expect(query.mock.calls[1]?.[0]).toContain(
      'read_workflow_call_declaration_input',
    );
  });
  it('only treats an explicit SQL null as no snapshot', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ snapshot: null }] });
    await expect(
      readWorkflowCallDeclarationInput(pool, { lease, signal }),
    ).resolves.toBeUndefined();
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(
      readWorkflowCallDeclarationInput(pool, { lease, signal }),
    ).rejects.toThrow('result is missing');
  });
  it('rejects returned reference/checksum mismatch', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ snapshot: { ...persistedSnapshot, sha256: 'f'.repeat(64) } }],
    });
    await expect(
      readWorkflowCallDeclarationInput(pool, { lease, signal }),
    ).rejects.toThrow('metadata does not match');
  });
  it.each([
    ['{ "name": "input" }', value],
    ['9007199254740993', 9007199254740992],
    ['1e-400', 0],
    ['-0', 0],
  ])(
    'verifies original %s bytes without recanonicalizing immutable identity',
    async (serializedValue, normalizedValue) => {
      const saved = {
        reference: { schemaVersion: 1, kind: 'inline', value: normalizedValue },
        serializedValue,
        sha256: createHash('sha256').update(serializedValue).digest('hex'),
        byteLength: Buffer.byteLength(serializedValue),
      };
      query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ snapshot: saved }] });
      await expect(
        readWorkflowCallDeclarationInput(pool, { lease, signal }),
      ).resolves.toEqual(saved);
    },
  );
  it('rejects intact bytes whose parsed value disagrees with the reference', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [
        {
          snapshot: {
            ...persistedSnapshot,
            reference: { ...snapshot.reference, value: 'different' },
          },
        },
      ],
    });
    await expect(
      readWorkflowCallDeclarationInput(pool, { lease, signal }),
    ).rejects.toThrow('do not agree');
  });
  it('rejects inline snapshots missing their immutable bytes', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ snapshot }] });
    await expect(
      readWorkflowCallDeclarationInput(pool, { lease, signal }),
    ).rejects.toThrow('bytes are missing');
  });
  it.each(['read', 'record'] as const)(
    'lets %s operational failure escape without a fabricated result',
    async (kind) => {
      const failure = new Error('SQL owner denied authority');
      query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(failure);
      const operation =
        kind === 'read'
          ? readWorkflowCallDeclarationInput(pool, { lease, signal })
          : recordWorkflowCallDeclarationInput(pool, {
              lease,
              ...snapshot,
              signal,
            });
      await expect(operation).rejects.toBe(failure);
    },
  );
});
