import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { seedWorkflow, withDatabase } from './upgrade-fixture.js';

it('preserves private rows on upgrade and only permits scoped removed-member storage deletion', async () => {
  await withDatabase(async ({ admin }) => {
    const { workspaceId, ownerId } = await seedWorkflow(admin);
    const targetId = randomUUID();
    await admin.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Private member')",
      [targetId, `${targetId}@example.test`],
    );
    await admin.query(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active'),($1,$3,'viewer','active')",
      [workspaceId, ownerId, targetId],
    );
    await admin.query(
      "insert into app.notice_preferences(workspace_id,user_id,mode) values($1,$2,'daily')",
      [workspaceId, targetId],
    );
    const retained = () =>
      admin.query<{ user_id: string; mode: string }>(
        'select user_id,mode from app.notice_preferences where workspace_id=$1',
        [workspaceId],
      );
    const before = (await retained()).rows;

    expect((await retained()).rows).toEqual(before);
    const invoke = async (table: string, scopedWorkspace = workspaceId) => {
      const client = await admin.connect();
      try {
        await client.query('begin');
        await client.query('set local role pertexo_app');
        await client.query(
          "select set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
          [workspaceId, ownerId],
        );
        // Capability must not grant cross-user read access.
        expect(
          (
            await client.query(
              'select user_id from app.notice_preferences where user_id=$1',
              [targetId],
            )
          ).rows,
        ).toEqual([]);
        const result = await client.query<{ deleted: number }>(
          'select app.delete_removed_member_private_rows($1,$2::uuid[],$3::regclass) deleted',
          [scopedWorkspace, [targetId], table],
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
    await expect(invoke('app.notice_preferences')).rejects.toHaveProperty(
      'code',
      '42501',
    );
    expect((await retained()).rows).toEqual(before);
    await admin.query(
      "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
      [workspaceId, targetId],
    );
    await expect(invoke('app.users')).rejects.toHaveProperty('code', '42501');
    await expect(
      invoke('app.notice_preferences', randomUUID()),
    ).rejects.toHaveProperty('code', '42501');
    expect((await retained()).rows).toEqual(before);
    expect(await invoke('app.notice_preferences')).toEqual([{ deleted: 1 }]);
    expect((await retained()).rows).toEqual([]);
  });
});
