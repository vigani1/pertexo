import { withTenantScopedReadClient } from '@pertexo/database/primitives';
import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';

import { WorkspaceAccessDeniedError } from '../../../src/shared/errors.js';
import {
  apiPool,
  actorId,
  otherActorId,
  workspaceId,
  otherWorkspaceId,
  identity,
  queryAsOwner,
  purgeTestWorkspace,
} from '../../support/workflow-authoring.js';
import {
  store,
  scope,
  columns,
  query,
  table,
  insert,
  required,
} from './fixture.js';

export function registerKeepsImportsAtomicPreventsEmpty(): void {
  it('keeps imports atomic and prevents empty-filter writes', async () => {
    const f = await table();
    await expect(
      store.importRows({
        ...scope(),
        tableId: f.id,
        idempotencyKey: randomUUID(),
        rows: [
          { key: 'valid', amount: 1 },
          { key: 'bad', amount: 'wrong' },
        ],
      }),
    ).rejects.toThrow('needs number');
    expect(
      (await store.find({ ...scope(), tableId: f.id, query })).rows,
    ).toHaveLength(0);
    await insert(f, 'a');
    await expect(
      store.write({
        ...scope(),
        tableId: f.id,
        idempotencyKey: randomUUID(),
        command: { operation: 'delete', table: f.name, query },
      }),
    ).rejects.toMatchObject({ code: 'unsafe_filter' });
    const removed = await store.write({
      ...scope(),
      tableId: f.id,
      idempotencyKey: randomUUID(),
      command: {
        operation: 'delete',
        table: f.name,
        query: {
          ...query,
          filters: [{ column: 'key', operator: 'equals', value: 'a' }],
        },
      },
    });
    expect(removed.affected).toBe(1);
  });

  it('rolls a late unique-key clash back with every imported row and quota charge', async () => {
    const f = await table();
    const before = (await store.list(scope())).quotas.storedBytes;
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      key: index === 999 ? 'row_0' : `row_${String(index)}`,
      amount: index,
    }));
    await expect(
      store.importRows({
        ...scope(),
        tableId: f.id,
        idempotencyKey: randomUUID(),
        rows,
      }),
    ).rejects.toMatchObject({ code: 'key_conflict' });
    expect(
      (await store.find({ ...scope(), tableId: f.id, query })).rows,
    ).toEqual([]);
    const after = await store.list(scope());
    expect(after.tables.find((item) => item.id === f.id)?.rowCount).toBe(0);
    expect(after.quotas.storedBytes).toBe(before);
  });

  it('checks live membership and scopes identical table names and raw RLS to their workspace', async () => {
    const f = await table();
    await insert(f, 'private');
    const raw = await withTenantScopedReadClient(
      apiPool,
      { workspaceId: otherWorkspaceId },
      (client) =>
        client.query(
          'select id from app.workspace_data_table_rows where table_id=$1',
          [f.id],
        ),
    );
    expect(raw.rows).toHaveLength(0);
    await expect(
      store.find({
        workspaceId: otherWorkspaceId,
        actorId: otherActorId,
        tableId: f.id,
        query,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      store.list({ workspaceId, actorId: otherActorId }),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    const viewer = randomUUID();
    await identity.createUser({
      id: viewer,
      email: `${viewer}@example.test`,
      displayName: 'Viewer',
    });
    await queryAsOwner(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'viewer','active')",
      [workspaceId, viewer],
      workspaceId,
    );
    expect(
      (await store.list({ workspaceId, actorId: viewer })).tables.some(
        (item) => item.id === f.id,
      ),
    ).toBe(true);
    await expect(
      store.create({
        workspaceId,
        actorId: viewer,
        name: 'Forbidden',
        columns,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });

  it('enforces a race-safe row quota and refuses each limit below current use', async () => {
    const isolated = await identity.createWorkspaceWithOwner({
      id: randomUUID(),
      name: 'Table quotas',
      slug: `tables-${randomUUID()}`,
      ownerUserId: actorId,
      idempotencyKey: randomUUID(),
    });
    const s = { workspaceId: isolated.id, actorId };
    await store.configure({
      ...s,
      idempotencyKey: randomUUID(),
      tableLimit: 2,
      columnLimit: 5,
      rowLimit: 1,
      byteLimit: 65536,
    });
    const f = await store.create({
      ...s,
      idempotencyKey: randomUUID(),
      name: 'Bounded',
      columns,
      keyColumn: 'key',
    });
    const results = await Promise.allSettled(
      ['a', 'b'].map((key) =>
        store.write({
          ...s,
          tableId: f.id,
          idempotencyKey: randomUUID(),
          command: {
            operation: 'insert',
            table: 'Bounded',
            values: { key, amount: 1 },
          },
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      ),
    ).toEqual([expect.objectContaining({ code: 'quota_exceeded' })]);
    const list = await store.list(s);
    expect(list.tables[0]?.rowCount).toBe(1);
    expect(list.quotas.storedBytes).toBeGreaterThan(0);
    const inUse = {
      tableLimit: 2,
      columnLimit: columns.length,
      rowLimit: 2,
      byteLimit: 65536,
    };
    await store.configure({ ...s, idempotencyKey: randomUUID(), ...inUse });
    await store.write({
      ...s,
      tableId: f.id,
      idempotencyKey: randomUUID(),
      command: {
        operation: 'insert',
        table: 'Bounded',
        values: { key: 'c', amount: 1 },
      },
    });
    await store.create({
      ...s,
      idempotencyKey: randomUUID(),
      name: 'Second',
      columns,
    });
    for (const below of [
      { tableLimit: 1 },
      { columnLimit: columns.length - 1 },
      { rowLimit: 1 },
    ])
      await expect(
        store.configure({
          ...s,
          idempotencyKey: randomUUID(),
          ...inUse,
          ...below,
        }),
        JSON.stringify(below),
      ).rejects.toMatchObject({ code: 'quota_exceeded' });
    await expect(
      store.configure({ ...s, idempotencyKey: randomUUID(), ...inUse }),
    ).resolves.toMatchObject(inUse);
    await purgeTestWorkspace(isolated.id);
    const retained = await queryAsOwner(
      'select id from app.workspace_data_tables where workspace_id=$1',
      [isolated.id],
      isolated.id,
    );
    expect(retained).toHaveLength(0);
  }, 30_000);

  it('refuses stale table deletion and updates accounting after explicit removal', async () => {
    const f = await table();
    const old = required(
      (await store.list(scope())).tables.find((item) => item.id === f.id),
    );
    await insert(f, 'a');
    await expect(
      store.remove({
        ...scope(),
        tableId: f.id,
        expectedRevision: old.revision,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const current = required(
      (await store.list(scope())).tables.find((item) => item.id === f.id),
    );
    await store.remove({
      ...scope(),
      tableId: f.id,
      expectedRevision: current.revision,
      idempotencyKey: randomUUID(),
    });
    await expect(
      store.find({ ...scope(), tableId: f.id, query }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
}
