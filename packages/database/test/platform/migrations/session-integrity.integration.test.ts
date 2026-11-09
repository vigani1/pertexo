import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { seedWorkflow, withDatabase } from './upgrade-fixture.js';

it('preserves populated sessions on upgrade and retains revocation for every writer and transaction rollback', async () => {
  await withDatabase(async ({ admin }) => {
    const { workspaceId, ownerId } = await seedWorkflow(admin);
    const removedUser = randomUUID();
    await admin.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Removed member')",
      [removedUser, `${removedUser}@example.test`],
    );
    await admin.query(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active'),($1,$3,'viewer','removed')",
      [workspaceId, ownerId, removedUser],
    );
    const issue = (userId: string) =>
      admin.query(
        "insert into app.auth_sessions(id,user_id,token,expires_at) values($1,$2,$3,clock_timestamp()+interval '1 hour')",
        [randomUUID(), userId, randomUUID()],
      );
    const sessions = async () =>
      (
        await admin.query<{ id: string; user_id: string; token: string }>(
          'select id,user_id,token from app.auth_sessions order by id',
        )
      ).rows;
    await issue(ownerId);
    await issue(removedUser);
    const before = await sessions();

    expect(await sessions()).toEqual(before);
    await admin.query('update app.users set email=$2 where id=$1', [
      ownerId,
      `${ownerId}@changed.test`,
    ]);
    expect((await sessions()).map((row) => row.user_id)).toEqual([removedUser]);
    await issue(ownerId);
    const connection = await admin.connect();
    try {
      await connection.query('begin');
      await connection.query(
        "update app.users set status='suspended' where id=$1",
        [ownerId],
      );
      expect(
        (
          await connection.query(
            'select count(*)::int count from app.auth_sessions where user_id=$1',
            [ownerId],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      await connection.query('rollback');
    } finally {
      connection.release();
    }
    expect(await sessions()).toHaveLength(2);
    await admin.query("update app.users set status='suspended' where id=$1", [
      ownerId,
    ]);
    expect((await sessions()).map((row) => row.user_id)).toEqual([removedUser]);
    await admin.query("update app.users set status='active' where id=$1", [
      ownerId,
    ]);
    await issue(ownerId);
    await admin.query(
      "update app.workspaces set status='suspended' where id=$1",
      [workspaceId],
    );
    expect((await sessions()).map((row) => row.user_id)).toEqual([removedUser]);
  });
});
