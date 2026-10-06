import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  parseWorkspaceId,
  workspaceTransactionFromClient,
} from '../src/tenant-access/workspace.js';

describe('internal same-client workspace transaction adapter', () => {
  it('uses the supplied client without owning transaction lifecycle or scope', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ value: 1 }] });
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const workspaceId = parseWorkspaceId(
      '11111111-1111-4111-8111-111111111111',
    );
    const transaction = workspaceTransactionFromClient(client, workspaceId);
    expect(Object.isFrozen(transaction)).toBe(true);
    expect(transaction.workspaceId).toBe(workspaceId);
    expect(query).not.toHaveBeenCalled();

    await transaction.db.execute(sql`select 1 as value`);
    expect(query).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: 'select 1 as value' }),
      [],
    );
    expect(release).not.toHaveBeenCalled();
  });
});
