import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const close = vi.hoisted(() => vi.fn());
const tenantState = vi.hoisted<{ client: PoolClient | undefined }>(() => ({
  client: undefined,
}));

vi.mock('../src/platform/database-runtime.js', () => ({
  acquireDatabasePool: () => ({ close, pool: {} }),
}));

vi.mock('../src/tenant-access/workspace.js', () => ({
  withTenantScopedClient: async (
    _pool: unknown,
    _scope: unknown,
    operation: (client: PoolClient) => Promise<unknown>,
  ) => {
    if (tenantState.client === undefined)
      throw new Error('Missing test client');
    return operation(tenantState.client);
  },
}));

import { createFailureNotificationDestinationDatabase } from '../src/execution/failure-notification-destinations.js';

const actorId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const destinationId = '33333333-3333-4333-8333-333333333333';
const connectionId = '44444444-4444-4444-8444-444444444444';

function result<T extends QueryResultRow>(
  rows: T[],
  rowCount = rows.length,
): QueryResult<T> {
  return {
    command: '',
    fields: [],
    oid: 0,
    rowCount,
    rows,
  };
}

function destinationRecord(kind: 'email' | 'slack') {
  return {
    id: destinationId,
    workspace_id: workspaceId,
    kind,
    status: 'enabled',
    current_config_version: 1,
    config:
      kind === 'email'
        ? { connectionId, toEmail: 'ops@example.test' }
        : { connectionId, channelId: 'C123' },
    created_at: new Date('2026-09-13T00:00:00.000Z'),
    updated_at: new Date('2026-09-13T00:00:00.000Z'),
  };
}

describe('failure notification destination decoding', () => {
  beforeEach(() => {
    close.mockReset();
    tenantState.client = undefined;
  });

  it('rejects a persisted row whose config kind conflicts with its canonical column', async () => {
    const row = {
      ...destinationRecord('email'),
      config: {
        kind: 'slack',
        connectionId,
        toEmail: 'ops@example.test',
      },
    };
    const query = vi.fn((text: string) =>
      Promise.resolve(
        text.includes('workspace_memberships') ? result([{}]) : result([row]),
      ),
    );
    tenantState.client = { query } as unknown as PoolClient;
    const database = createFailureNotificationDestinationDatabase({
      connectionString: 'postgres://unused',
    } as never);

    await expect(
      database.get({ actorId, destinationId, workspaceId }),
    ).rejects.toThrow(
      'Destination kind does not match persisted configuration',
    );
  });

  it('rejects an idempotent replay whose record kind conflicts with its config kind', async () => {
    const replay = {
      ...destinationRecord('email'),
      workspaceId,
      currentVersion: 1,
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:00:00.000Z',
      config: {
        kind: 'slack',
        connectionId,
        channelId: 'C123',
      },
    };
    delete (replay as { workspace_id?: unknown }).workspace_id;
    delete (replay as { current_config_version?: unknown })
      .current_config_version;
    delete (replay as { created_at?: unknown }).created_at;
    delete (replay as { updated_at?: unknown }).updated_at;
    const query = vi.fn((text: string) => {
      if (text.includes('workspace_memberships'))
        return Promise.resolve(result([{}]));
      if (text.includes('insert into app.idempotency_records'))
        return Promise.resolve(result([], 1));
      if (text.includes('select request_hash,status,result_ref'))
        return Promise.resolve(
          result([
            {
              request_hash: 'a'.repeat(64),
              status: 'completed',
              result_ref: { schemaVersion: 1, result: replay },
            },
          ]),
        );
      throw new Error(`Unexpected query: ${text}`);
    });
    tenantState.client = { query } as unknown as PoolClient;
    const database = createFailureNotificationDestinationDatabase({
      connectionString: 'postgres://unused',
    } as never);

    await expect(
      database.create({
        actorId,
        destinationId,
        workspaceId,
        config: { kind: 'email', connectionId, toEmail: 'ops@example.test' },
        idempotencyKey: 'replay-key',
        requestHash: 'a'.repeat(64),
      }),
    ).rejects.toThrow('Destination kind does not match replayed configuration');
  });
});
