import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { WorkspaceVariablesConflictError } from '../../../src/variables/contract.js';
import { WorkspaceAccessDeniedError } from '@pertexo/database/tenant-access';

import { withWorkspaceTransaction } from '../../../../database/src/tenant-access/transactions.js';

import { admin } from '../../../../database/test/lifecycle/calls/fixtures.js';

import { store, pool, fixture, scope } from './fixture.js';

export function registerStoresTypedCurrentValuesOnce(): void {
  it('stores typed current values once, acknowledges exact commands and audits names without values', async () => {
    const f = await fixture();
    expect(await store.read(scope(f.workspaceId))).toEqual({
      revision: 0,
      values: {},
      descriptions: {},
    });
    const values = {
      CURRENCY: 'EUR-sensitive-to-audit',
      ZERO: 0,
      OFF: false,
      EMPTY: '',
    };
    const command = {
      ...scope(f.workspaceId),
      idempotencyKey: randomUUID(),
      expectedRevision: 0,
      values,
    };
    expect(await store.replace(command)).toEqual({
      revision: 1,
      changed: true,
      replayed: false,
    });
    expect(await store.replace(command)).toEqual({
      revision: 1,
      changed: true,
      replayed: true,
    });
    expect(await store.read(scope(f.workspaceId))).toEqual({
      revision: 1,
      values,
      descriptions: {},
    });
    expect(
      await store.replace({
        ...command,
        idempotencyKey: randomUUID(),
        expectedRevision: 1,
      }),
    ).toEqual({ revision: 1, changed: false, replayed: false });
    const audits = await admin.query<{ metadata: unknown }>(
      "select metadata from app.audit_events where workspace_id=$1 and action='workspace.variables_changed'",
      [f.workspaceId],
    );
    expect(audits.rows).toHaveLength(1);
    expect(JSON.stringify(audits.rows)).not.toContain('EUR-sensitive-to-audit');
    expect(audits.rows[0]?.metadata).toEqual({
      revision: 1,
      changedNames: ['CURRENCY', 'EMPTY', 'OFF', 'ZERO'],
    });
  });

  it('lets one concurrent first revision win and refuses stale overwrites', async () => {
    const f = await fixture();
    const save = (value: number) =>
      store.replace({
        ...scope(f.workspaceId),
        idempotencyKey: randomUUID(),
        expectedRevision: 0,
        values: { RATE: value },
      });
    const results = await Promise.allSettled([save(1), save(2)]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(
      WorkspaceVariablesConflictError,
    );
    const current = await store.read(scope(f.workspaceId));
    expect(current.revision).toBe(1);
    expect([1, 2]).toContain(current.values.RATE);
    await expect(save(3)).rejects.toBeInstanceOf(
      WorkspaceVariablesConflictError,
    );
  });

  it('allows member reads but rechecks current write authority, removal and inactive workspace state', async () => {
    const f = await fixture(),
      memberId = randomUUID();
    await store.replace({
      ...scope(f.workspaceId),
      idempotencyKey: randomUUID(),
      expectedRevision: 0,
      values: { RATE: 1 },
    });
    await admin.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Variable reader')",
      [memberId, `${memberId}@example.test`],
    );
    await admin.query(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'admin','active')",
      [f.workspaceId, memberId],
    );
    await store.replace({
      workspaceId: f.workspaceId,
      actorId: memberId,
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      values: { RATE: 2 },
    });
    await admin.query(
      "update app.workspace_memberships set role='builder',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
      [f.workspaceId, memberId],
    );
    expect(
      (await store.read({ workspaceId: f.workspaceId, actorId: memberId }))
        .values.RATE,
    ).toBe(2);
    await expect(
      store.replace({
        workspaceId: f.workspaceId,
        actorId: memberId,
        idempotencyKey: randomUUID(),
        expectedRevision: 2,
        values: { RATE: 3 },
      }),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    await admin.query(
      "update app.workspaces set status='suspended' where id=$1",
      [f.workspaceId],
    );
    expect((await store.read(scope(f.workspaceId))).values.RATE).toBe(2);
    await expect(
      store.replace({
        ...scope(f.workspaceId),
        idempotencyKey: randomUUID(),
        expectedRevision: 2,
        values: { RATE: 3 },
      }),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    await admin.query("update app.workspaces set status='active' where id=$1", [
      f.workspaceId,
    ]);
    await admin.query(
      "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
      [f.workspaceId, memberId],
    );
    await expect(
      store.read({ workspaceId: f.workspaceId, actorId: memberId }),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });

  it('forces workspace row security even without a caller-supplied filter', async () => {
    const a = await fixture(),
      b = await fixture();
    for (const f of [a, b])
      await store.replace({
        ...scope(f.workspaceId),
        idempotencyKey: randomUUID(),
        expectedRevision: 0,
        values: { RATE: 1 },
      });
    const rows = await withWorkspaceTransaction(
      pool,
      a.workspaceId,
      (transaction) =>
        transaction.db.execute(
          sql`select workspace_id from app.workspace_variables`,
        ),
    );
    expect(rows.rows).toEqual([{ workspace_id: a.workspaceId }]);
    expect(
      (await pool.query('select workspace_id from app.workspace_variables'))
        .rows,
    ).toEqual([]);
    expect(
      (
        await withWorkspaceTransaction(pool, a.workspaceId, (transaction) =>
          transaction.db.execute(
            sql`select workspace_id from app.workspace_variable_set_revisions`,
          ),
        )
      ).rows,
    ).toEqual([{ workspace_id: a.workspaceId }]);
    expect(
      (
        await pool.query(
          'select workspace_id from app.workspace_variable_set_revisions',
        )
      ).rows,
    ).toEqual([]);
    await expect(
      withWorkspaceTransaction(pool, a.workspaceId, (transaction) =>
        transaction.db.execute(
          sql`update app.workspace_variable_set_revisions set values_json='{}'::jsonb`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      withWorkspaceTransaction(pool, a.workspaceId, (transaction) =>
        transaction.db.execute(
          sql`update app.workspace_variable_set_revisions set descriptions_json='{}'::jsonb`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
}
