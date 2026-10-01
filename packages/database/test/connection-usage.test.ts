import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

const tenant = vi.hoisted<{ client?: PoolClient }>(() => ({}));
vi.mock('../src/tenant-access/workspace.js', () => ({
  withTenantScopedClient: async (
    _pool: unknown,
    _scope: unknown,
    operation: (client: PoolClient) => Promise<unknown>,
  ) => {
    if (tenant.client === undefined) throw new Error('missing test client');
    return operation(tenant.client);
  },
}));

import { createConnectionUsagePersistence } from '../src/connections/connection-usage-persistence.js';
import { ConnectionNotFoundError } from '../src/connections/connection-persistence.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const connectionId = '33333333-3333-4333-8333-333333333333';
const versionId = '44444444-4444-4444-8444-444444444444';
const input = { workspaceId, actorId, connectionId };
const row = {
  workflow_id: actorId,
  workflow_name: 'Published',
  lifecycle_status: 'active',
  workflow_version_id: versionId,
  version_number: 1,
  is_current_publication: true,
  operation_keys: ['send_message'],
};

function fixture(
  rows: unknown[] = [],
  absent?: 'authority' | 'connection' | 'anchor',
) {
  const query = vi.fn((sql: string) =>
    Promise.resolve({
      rows: sql.startsWith('with page') ? rows : [{}],
      rowCount:
        (absent === 'authority' && sql.includes('workspace_memberships')) ||
        (absent === 'connection' && sql.startsWith('select id')) ||
        (absent === 'anchor' &&
          sql.startsWith('select 1 from app.workflow_integration_usage'))
          ? 0
          : 1,
    }),
  );
  tenant.client = { query } as unknown as PoolClient;
  return { query, database: createConnectionUsagePersistence({} as Pool) };
}

describe('connection usage bounded persistence contract', () => {
  it('defaults to fifty and limits before metadata joins', async () => {
    const { query, database } = fixture([row]);
    expect(
      (await database.listConnectionUsage(input)).items[0]?.workflowVersionId,
    ).toBe(versionId);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('limit $4'),
      [workspaceId, connectionId, null, 51],
    );
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes('workspace_memberships'),
      )?.[0],
    ).toContain('for share of membership, workspace, actor');
  });
  it('uses a version cursor and reports more only with a sentinel row', async () => {
    const { database } = fixture([
      row,
      { ...row, workflow_version_id: workspaceId },
    ]);
    expect(
      await database.listConnectionUsage({
        ...input,
        limit: 1,
        after: { workflowVersionId: actorId },
      }),
    ).toMatchObject({ nextCursor: { workflowVersionId: versionId } });
  });
  it('handles empty pages and an unpublished current pointer', async () => {
    expect(await fixture().database.listConnectionUsage(input)).toEqual({
      items: [],
    });
    expect(
      (
        await fixture([
          { ...row, is_current_publication: null },
        ]).database.listConnectionUsage(input)
      ).items[0]?.isCurrentPublication,
    ).toBe(false);
  });
  it.each(['authority', 'connection', 'anchor'] as const)(
    'nondiscloses absent %s before paging',
    async (absent) => {
      const { query, database } = fixture([], absent);
      await expect(
        database.listConnectionUsage({
          ...input,
          after: { workflowVersionId: versionId },
        }),
      ).rejects.toThrow(ConnectionNotFoundError);
      expect(
        query.mock.calls.some(([sql]) => sql.startsWith('with page')),
      ).toBe(false);
    },
  );
  it.each([0, 101, 1.5])('rejects limit %s', (limit) => {
    expect(() =>
      fixture().database.listConnectionUsage({ ...input, limit }),
    ).toThrow();
  });
  it('rejects corrupt persisted metadata', async () => {
    await expect(
      fixture([{ ...row, version_number: 0 }]).database.listConnectionUsage(
        input,
      ),
    ).rejects.toThrow();
  });
});
