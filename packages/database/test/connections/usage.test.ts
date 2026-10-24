import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

const tenant = vi.hoisted<{ client?: PoolClient }>(() => ({}));
vi.mock('../../src/tenant-access/transactions.js', () => ({
  withTenantScopedClient: async (
    _pool: unknown,
    _scope: unknown,
    operation: (client: PoolClient) => Promise<unknown>,
  ) => {
    if (tenant.client === undefined) throw new Error('missing test client');
    return operation(tenant.client);
  },
}));

import { createConnectionUsagePersistence } from '../../src/connections/discovery/usage.queries.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const connectionId = '33333333-3333-4333-8333-333333333333';
const input = { workspaceId, actorId, connectionId };
function fixture() {
  const query = vi.fn();
  tenant.client = { query } as unknown as PoolClient;
  return { query, database: createConnectionUsagePersistence({} as Pool) };
}
describe('connection usage input boundary', () => {
  it.each([0, 101, 1.5])(
    'rejects limit %s before accessing storage',
    (limit) => {
      const { query, database } = fixture();
      expect(() => database.listConnectionUsage({ ...input, limit })).toThrow();
      expect(query).not.toHaveBeenCalled();
    },
  );
});
