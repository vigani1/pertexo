import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { useIdentityCommandDatabase } from '../command.support.js';

const database = useIdentityCommandDatabase('removed_private');
const privateTables = [
  'notice_preferences',
  'notice_subscriptions',
  'workspace_inbox_reads',
] as const;

async function setup() {
  const owner = await database.user('Owner'),
    target = await database.user('Departing person'),
    survivor = await database.user('Remaining person');
  const workspaceId = await database.workspace(owner.id),
    otherWorkspaceId = await database.workspace(owner.id);
  for (const scope of [workspaceId, otherWorkspaceId]) {
    await database.member(scope, target.id, 'viewer');
    await database.member(scope, survivor.id, 'viewer');
    const workflowId = randomUUID(),
      threadId = randomUUID();
    await database.asAdmin(
      "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Followed workflow',$3)",
      [workflowId, scope, owner.id],
    );
    await database.asAdmin(
      "insert into app.workspace_inbox_threads(workspace_id,id,notice_kind,subject_id,workflow_id,revision,occurrence_count,first_occurred_at,latest_occurred_at) values($1,$2,'workflow_auto_paused',$3,$3,1,1,clock_timestamp(),clock_timestamp())",
      [scope, threadId, workflowId],
    );
    for (const user of [target, survivor]) {
      await database.asAdmin(
        "insert into app.notice_preferences(workspace_id,user_id,mode) values($1,$2,'daily')",
        [scope, user.id],
      );
      await database.asAdmin(
        "insert into app.notice_subscriptions(workspace_id,user_id,subject_kind,subject_id,workflow_id,followed) values($1,$2,'workflow',$3,$3,true)",
        [scope, user.id, workflowId],
      );
      await database.asAdmin(
        'insert into app.workspace_inbox_reads(workspace_id,user_id,thread_id,read_revision) values($1,$2,$3,1)',
        [scope, user.id, threadId],
      );
    }
  }
  const command = {
    workspaceId,
    actorUserId: owner.id,
    targetUserId: target.id,
    expectedRoleRevision: 1,
    idempotencyKey: randomUUID(),
  };
  return { owner, target, survivor, workspaceId, otherWorkspaceId, command };
}
async function retained(workspaceId: string, userId: string) {
  const counts = [];
  for (const table of privateTables)
    counts.push(
      (
        await database.asAdmin<{ count: number }>(
          `select count(*)::int count from app.${table} where workspace_id=$1 and user_id=$2`,
          [workspaceId, userId],
        )
      )[0]?.count,
    );
  return counts;
}
it('removes all private notice state atomically through member removal without exposing another person or workspace', async () => {
  const f = await setup();
  await withTenantScopedClient(
    database.authenticationPool(),
    { workspaceId: f.workspaceId, actorId: f.owner.id },
    async (client) => {
      for (const table of privateTables)
        expect(
          (
            await client.query(
              `select user_id from app.${table} where user_id=$1`,
              [f.target.id],
            )
          ).rows,
        ).toEqual([]);
    },
  );
  await database.identity().removeWorkspaceMember(f.command);
  expect(await retained(f.workspaceId, f.target.id)).toEqual([0, 0, 0]);
  expect(await retained(f.workspaceId, f.survivor.id)).toEqual([1, 1, 1]);
  expect(await retained(f.otherWorkspaceId, f.target.id)).toEqual([1, 1, 1]);
  expect(
    await database.identity().removeWorkspaceMember(f.command),
  ).toMatchObject({ replayed: true });
});
it('rolls removal and every private deletion back when the final private-state delete fails', async () => {
  const f = await setup();
  await database.asAdmin(
    "create function app.test_refuse_private_cleanup() returns trigger language plpgsql as $$ begin raise exception 'private cleanup failure'; end $$",
  );
  await database.asAdmin(
    'create trigger test_refuse_private_cleanup before delete on app.workspace_inbox_reads for each row execute function app.test_refuse_private_cleanup()',
  );
  try {
    await expect(
      database.identity().removeWorkspaceMember(f.command),
    ).rejects.toThrow('private cleanup failure');
  } finally {
    await database.asAdmin(
      'drop trigger test_refuse_private_cleanup on app.workspace_inbox_reads',
    );
    await database.asAdmin('drop function app.test_refuse_private_cleanup()');
  }
  expect(await retained(f.workspaceId, f.target.id)).toEqual([1, 1, 1]);
  expect(
    await database.asAdmin(
      'select status,role_revision from app.workspace_memberships where workspace_id=$1 and user_id=$2',
      [f.workspaceId, f.target.id],
    ),
  ).toEqual([{ status: 'active', role_revision: 1 }]);
  await database.identity().removeWorkspaceMember(f.command);
  expect(await retained(f.workspaceId, f.target.id)).toEqual([0, 0, 0]);
});
