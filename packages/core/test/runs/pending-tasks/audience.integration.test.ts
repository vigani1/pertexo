import { expect, it } from 'vitest';
import { WorkspaceAccessDeniedError } from '../../../src/shared/errors.js';
import { admin, store, taskFixture, userId } from './fixtures.js';

it('inspects the entire current audience independent of member pagination and search', async () => {
  const f = await taskFixture();
  const scope = { workspaceId: f.workspaceId, actorId: userId };
  await admin.query(
    `with people as (insert into app.users(id,email,display_name) select gen_random_uuid(),'audience-'||gen_random_uuid()||'@example.test','Audience member' from generate_series(1,60) returning id) insert into app.workspace_memberships(workspace_id,user_id,role,status) select $1,id,'admin','active' from people`,
    [f.workspaceId],
  );
  expect((await store.audience({ ...scope, q: '' })).items).toHaveLength(50);
  expect(
    await store.inspectAudience({
      ...scope,
      audience: { roles: ['owner', 'admin'], memberIds: [userId, f.deciderId] },
    }),
  ).toEqual({ matchingMemberCount: 62, actorMatchesAudience: true });
  expect(
    await store.inspectAudience({
      ...scope,
      audience: { roles: ['owner'], memberIds: [] },
    }),
  ).toEqual({ matchingMemberCount: 1, actorMatchesAudience: true });
  expect(
    await store.inspectAudience({
      ...scope,
      audience: { roles: [], memberIds: [f.deciderId] },
    }),
  ).toEqual({ matchingMemberCount: 1, actorMatchesAudience: false });
  await admin.query("update app.users set status='suspended' where id=$1", [
    f.deciderId,
  ]);
  expect(
    await store.inspectAudience({
      ...scope,
      audience: { roles: [], memberIds: [f.deciderId] },
    }),
  ).toEqual({ matchingMemberCount: 0, actorMatchesAudience: false });
  await admin.query(
    "update app.workspace_memberships set role='viewer' where workspace_id=$1 and user_id=$2",
    [f.workspaceId, userId],
  );
  await expect(
    store.inspectAudience({
      ...scope,
      audience: { roles: ['owner'], memberIds: [] },
    }),
  ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
});
