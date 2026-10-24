import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { withTenantScopedClient } from '../../../src/tenant-access/transactions.js';
import { updateMemberships } from '../../../src/tenant-access/members/records.repository.js';
import type { MembershipChange } from '../../../src/tenant-access/members/contract.js';
import { revokeSessionsForUsers } from '../../../src/tenant-access/users/sessions.repository.js';
import {
  appendAuditFacts,
  type AuditFact,
} from '../../../src/governance/audit/events.repository.js';
import { useIdentityCommandDatabase } from '../command.support.js';

const database = useIdentityCommandDatabase('member_batch');
async function setup() {
  const owner = await database.user('Batch owner');
  const workspaceId = await database.workspace(owner.id),
    otherWorkspaceId = await database.workspace(owner.id);
  const people = await Promise.all(
    ['First', 'Second', 'Third'].map((name) => database.user(name)),
  );
  for (const person of people) {
    await database.member(workspaceId, person.id, 'viewer');
    await database.member(otherWorkspaceId, person.id, 'viewer');
    await database.sessions(person.id);
  }
  await database.sessions(owner.id);
  for (const scope of [workspaceId, otherWorkspaceId]) {
    const workflowId = randomUUID();
    await database.asAdmin(
      "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Batch cleanup',$3)",
      [workflowId, scope, owner.id],
    );
    await database.asAdmin(
      "insert into app.notice_preferences(workspace_id,user_id,mode) select $1,id,'immediate' from unnest($2::uuid[]) id",
      [scope, people.map((person) => person.id)],
    );
    await database.asAdmin(
      'insert into app.workflow_favorites(workspace_id,actor_id,workflow_id) select $1,id,$2 from unnest($3::uuid[]) id',
      [scope, workflowId, people.map((person) => person.id)],
    );
  }
  const changes: MembershipChange[] = people.map((person, index) => ({
    userId: person.id,
    role: index === 1 ? 'operator' : 'viewer',
    status: index === 1 ? 'active' : 'removed',
    roleRevision: 2,
  }));
  const facts: AuditFact[] = changes.map((change) => ({
    workspaceId,
    actorId: owner.id,
    action:
      change.status === 'removed'
        ? 'workspace.member_removed'
        : 'workspace.member_role_changed',
    targetType: 'workspace_member',
    targetId: change.userId,
    metadata: { role: change.role, status: change.status },
  }));
  return { owner, workspaceId, otherWorkspaceId, people, changes, facts };
}
async function counts(workspaceId: string) {
  return database.asAdmin<{
    preferences: number;
    favorites: number;
    audits: number;
  }>(
    `select (select count(*)::int from app.notice_preferences where workspace_id=$1) preferences,
      (select count(*)::int from app.workflow_favorites where workspace_id=$1) favorites,
      (select count(*)::int from app.audit_events where workspace_id=$1 and action in ('workspace.member_removed','workspace.member_role_changed')) audits`,
    [workspaceId],
  );
}
describe('batched membership side effects', () => {
  it('changes roles, clears every removed member’s private state and revokes sessions without affecting another workspace', async () => {
    const f = await setup();
    await withTenantScopedClient(
      database.authenticationPool(),
      { workspaceId: f.workspaceId, actorId: f.owner.id },
      async (client) => {
        await updateMemberships(client, f.workspaceId, f.changes);
        await revokeSessionsForUsers(
          client,
          f.people.map((person) => person.id),
        );
        await appendAuditFacts(client, f.facts);
      },
    );
    expect(
      await database.asAdmin<{
        user_id: string;
        role: string;
        status: string;
        role_revision: number;
      }>(
        'select user_id,role,status,role_revision from app.workspace_memberships where workspace_id=$1 and user_id=any($2::uuid[]) order by user_id',
        [f.workspaceId, f.people.map((person) => person.id)],
      ),
    ).toEqual(
      f.changes
        .map((change) => ({
          user_id: change.userId,
          role: change.role,
          status: change.status,
          role_revision: change.roleRevision,
        }))
        .sort((a, b) => (a.user_id < b.user_id ? -1 : 1)),
    );
    expect(
      await database.asAdmin(
        'select role,status,role_revision from app.workspace_memberships where workspace_id=$1 and user_id=any($2::uuid[])',
        [f.otherWorkspaceId, f.people.map((person) => person.id)],
      ),
    ).toEqual(
      f.people.map(() => ({
        role: 'viewer',
        status: 'active',
        role_revision: 1,
      })),
    );
    expect(await counts(f.workspaceId)).toEqual([
      { preferences: 1, favorites: 1, audits: 3 },
    ]);
    expect(await counts(f.otherWorkspaceId)).toEqual([
      { preferences: 3, favorites: 3, audits: 0 },
    ]);
    for (const person of f.people)
      expect(await database.liveSessions(person.id)).toBe(0);
    expect(await database.liveSessions(f.owner.id)).toBe(1);
  });
  it('rolls membership, cleanup, revocation and every audit fact back if a batch crosses the workspace fence', async () => {
    const f = await setup();
    await expect(
      withTenantScopedClient(
        database.authenticationPool(),
        { workspaceId: f.workspaceId, actorId: f.owner.id },
        async (client) => {
          await updateMemberships(client, f.workspaceId, f.changes);
          await revokeSessionsForUsers(
            client,
            f.people.map((person) => person.id),
          );
          await appendAuditFacts(client, [
            ...f.facts,
            {
              ...f.facts[0],
              workspaceId: f.otherWorkspaceId,
              action: 'workspace.member_removed',
              targetType: 'workspace_member',
              targetId: f.owner.id,
            },
          ]);
        },
      ),
    ).rejects.toHaveProperty('code', '42501');
    expect(await counts(f.workspaceId)).toEqual([
      { preferences: 3, favorites: 3, audits: 0 },
    ]);
    expect(
      await database.asAdmin(
        'select role,status,role_revision from app.workspace_memberships where workspace_id=$1 and user_id=any($2::uuid[])',
        [f.workspaceId, f.people.map((person) => person.id)],
      ),
    ).toEqual(
      f.people.map(() => ({
        role: 'viewer',
        status: 'active',
        role_revision: 1,
      })),
    );
    for (const person of f.people)
      expect(await database.liveSessions(person.id)).toBe(1);
  });
  it('commits 5,000 changed memberships, session revocations and individual audit facts together', async () => {
    const owner = await database.user('Maximum batch owner'),
      workspaceId = await database.workspace(owner.id);
    const ids = Array.from({ length: 5000 }, () => randomUUID());
    await database.asAdmin(
      "insert into app.users(id,email,display_name,email_verified) select id,id::text||'@batch.example.test','Batch member',true from unnest($1::uuid[]) id",
      [ids],
    );
    await database.asAdmin(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) select $1,id,'viewer','active' from unnest($2::uuid[]) id",
      [workspaceId, ids],
    );
    await database.asAdmin(
      "insert into app.auth_sessions(id,user_id,token,expires_at) select gen_random_uuid(),id,id::text,clock_timestamp()+interval '1 hour' from unnest($1::uuid[]) id",
      [ids],
    );
    const changes: MembershipChange[] = ids.map((userId) => ({
      userId,
      role: 'builder',
      status: 'active',
      roleRevision: 2,
    }));
    const facts: AuditFact[] = ids.map((targetId) => ({
      workspaceId,
      actorId: owner.id,
      action: 'workspace.member_role_changed',
      targetType: 'workspace_member',
      targetId,
      metadata: { fromRole: 'viewer', toRole: 'builder' },
    }));
    const started = performance.now();
    await withTenantScopedClient(
      database.authenticationPool(),
      { workspaceId, actorId: owner.id },
      async (client) => {
        await updateMemberships(client, workspaceId, changes);
        await revokeSessionsForUsers(client, ids);
        await appendAuditFacts(client, facts);
      },
    );
    const millis = Math.round(performance.now() - started);
    const result = await database.asAdmin<{
      members: number;
      sessions: number;
      audits: number;
    }>(
      `select
      (select count(*)::int from app.workspace_memberships where workspace_id=$1 and role='builder' and status='active' and role_revision=2) members,
      (select count(*)::int from app.auth_sessions where user_id=any($2::uuid[])) sessions,
      (select count(*)::int from app.audit_events where workspace_id=$1 and action='workspace.member_role_changed') audits`,
      [workspaceId, ids],
    );
    expect(result).toEqual([{ members: 5000, sessions: 0, audits: 5000 }]);
    await writeFile(
      '/tmp/pertexo-scim-membership-batch.json',
      JSON.stringify({ members: 5000, millis, result }),
    );
  }, 60_000);
});
