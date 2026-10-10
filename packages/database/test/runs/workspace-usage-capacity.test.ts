import type { Pool } from 'pg';
import type { WorkspaceTransaction } from '../../src/tenant-access/transactions.js';
import { WorkspaceAccessDeniedError } from '../../src/tenant-access/errors.js';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const fixture = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn() }));
vi.mock('../../src/tenant-access/transactions.js', () => ({
  withWorkspaceReadTransaction: fixture.transaction,
}));
import { readWorkspaceUsageCapacity } from '../../src/runs/queries/usage-capacity.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const pool = {} as Pool;
const row = {
  as_of: '2026-10-01T01:00:00.123456Z',
  active_runs: 2,
  reserved_active_slots: 1,
  queued_runs: 3,
  policy_state: 'active',
  version: 1,
  active_run_limit: 5,
  queued_run_limit: 100,
  charged_bytes: '9007199254740993',
  byte_limit: '9223372036854775807',
  charged_count: 2,
  artifact_count_limit: 0,
  capacity_source: 'stored',
};
beforeEach(() => {
  vi.clearAllMocks();
  fixture.execute.mockResolvedValue({ rows: [row] });
  fixture.transaction.mockImplementation(
    (
      _pool: Pool,
      scope: string,
      operation: (transaction: WorkspaceTransaction) => Promise<unknown>,
    ) =>
      operation({
        workspaceId: scope,
        db: { execute: fixture.execute },
      } as unknown as WorkspaceTransaction),
  );
});
describe('workspace capacity snapshot', () => {
  it('does not return defaults after workspace access is lost', async () => {
    fixture.execute.mockResolvedValue({ rows: [] });
    await expect(
      readWorkspaceUsageCapacity(pool, { workspaceId }),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });
  it('preserves exact byte precision and distinguishes reservations from active runs', async () => {
    const signal = new AbortController().signal;
    const result = await readWorkspaceUsageCapacity(pool, {
      workspaceId,
      signal,
    });
    expect(result.execution).toMatchObject({
      activeRuns: 2,
      reservedActiveSlots: 1,
      activeCapacityConsumed: 3,
      queuedRuns: 3,
    });
    expect(result.artifacts).toEqual({
      chargedBytes: '9007199254740993',
      byteLimit: '9223372036854775807',
      chargedCount: 2,
      artifactCountLimit: 0,
      source: 'stored',
    });
    expect(result.asOf).toBe(row.as_of);
    expect(fixture.transaction).toHaveBeenCalledWith(
      pool,
      workspaceId,
      expect.any(Function),
      { statementTimeoutMillis: 2000, signal },
    );
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });
  it('validates scope before opening a transaction', async () => {
    await expect(
      readWorkspaceUsageCapacity(pool, { workspaceId: 'invalid' }),
    ).rejects.toThrow();
    expect(fixture.transaction).not.toHaveBeenCalled();
  });
  it.each(['-1', '01', '1.2', '1e3'])(
    'rejects noncanonical bytes %s',
    async (charged_bytes) => {
      fixture.execute.mockResolvedValue({ rows: [{ ...row, charged_bytes }] });
      await expect(
        readWorkspaceUsageCapacity(pool, { workspaceId }),
      ).rejects.toThrow();
    },
  );
  it('does not turn missing authority into default execution limits', async () => {
    fixture.execute.mockResolvedValue({
      rows: [
        {
          ...row,
          policy_state: 'unavailable',
          version: null,
          active_run_limit: null,
          queued_run_limit: null,
        },
      ],
    });
    expect(
      (await readWorkspaceUsageCapacity(pool, { workspaceId })).execution
        .policy,
    ).toEqual({
      state: 'unavailable',
      version: null,
      activeRunLimit: null,
      queuedRunLimit: null,
    });
  });
});
