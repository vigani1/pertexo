import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { seedWorkflow, withUpgradeDatabase } from './upgrade-fixture.js';

it('preserves purge-worker authority to delete removed members private state without admitting active members', async () => {
  await withUpgradeDatabase(108, async ({ admin, upgrade }) => {
    const { workspaceId, ownerId } = await seedWorkflow(admin);
    const removedId = randomUUID();
    await admin.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Removed directory member')",
      [removedId, `${removedId}@example.test`],
    );
    await admin.query(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active'),($1,$3,'viewer','removed')",
      [workspaceId, ownerId, removedId],
    );
    await admin.query(
      "insert into app.notice_preferences(workspace_id,user_id,mode) values($1,$2,'daily'),($1,$3,'daily')",
      [workspaceId, ownerId, removedId],
    );
    const read = async () =>
      (
        await admin.query<{ user_id: string; mode: string }>(
          'select user_id,mode from app.notice_preferences where workspace_id=$1 order by user_id',
          [workspaceId],
        )
      ).rows;
    const before = await read();
    await upgrade();
    expect(await read()).toEqual(before);
    const clean = async (userId: string) => {
      const client = await admin.connect();
      try {
        await client.query('begin');
        await client.query('set local role pertexo_maintenance');
        await client.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        const result = await client.query<{ deleted: number }>(
          "select app.delete_removed_member_private_rows($1,$2::uuid[],'app.notice_preferences'::regclass) deleted",
          [workspaceId, [userId]],
        );
        await client.query('commit');
        return result.rows;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    };
    await expect(clean(ownerId)).rejects.toHaveProperty('code', '42501');
    expect(await clean(removedId)).toEqual([{ deleted: 1 }]);
    expect(await read()).toEqual([{ user_id: ownerId, mode: 'daily' }]);
  });
});
