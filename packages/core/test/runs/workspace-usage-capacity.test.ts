import { drizzle } from 'drizzle-orm/node-postgres';
import { databaseSchema } from '@pertexo/database/schema';
import type { Pool, PoolClient } from 'pg';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const fixture = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../../../database/dist/tenant-access/transactions.js', () => ({
  withWorkspaceReadTransaction: fixture.transaction,
}));
import { readWorkspaceUsageCapacity } from '../../src/runs/queries/usage-capacity.queries.js';

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
function wireRow(value: typeof row) {
  return [
    value.as_of,
    value.active_runs,
    value.queued_runs,
    value.reserved_active_slots,
    value.policy_state,
    value.version,
    value.active_run_limit,
    value.queued_run_limit,
    value.charged_bytes,
    value.byte_limit,
    value.charged_count,
    value.artifact_count_limit,
    value.capacity_source,
  ];
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.query.mockResolvedValue({ rows: [wireRow(row)] });
  fixture.transaction.mockImplementation(
    (
      _pool: Pool,
      scope: string,
      operation: (transaction: WorkspaceTransaction) => Promise<unknown>,
    ) =>
      operation({
        workspaceId: scope,
        db: drizzle({
          client: { query: fixture.query } as unknown as PoolClient,
          schema: databaseSchema,
        }),
      } as unknown as WorkspaceTransaction),
  );
});
describe('workspace capacity snapshot', () => {
  it('preserves exact byte precision and distinguishes reservations from active runs', async () => {
    const result = await readWorkspaceUsageCapacity(pool, { workspaceId });
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
  });
});
