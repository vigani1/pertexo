import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import type { QueryResult } from 'pg';
import { useIdentityCommandDatabase } from '../../command.support.js';
import { createDirectoryCredential } from '../../../../src/identity/federation/provisioning/management/credentials.repository.js';
import { replaceDirectoryMappings } from '../../../../src/identity/federation/provisioning/management/mappings.repository.js';
import {
  authenticateDirectory,
  withDirectoryTransaction,
} from '../../../../src/identity/federation/provisioning/authority.repository.js';
import { projectDirectoryMemberships } from '../../../../src/identity/federation/provisioning/projection.repository.js';
import { DIRECTORY_LIMITS } from '../../../../src/identity/federation/provisioning/limits.js';

const db = useIdentityCommandDatabase('scim_fanout');
it('projects maximum directory fan-out atomically without per-person round trips or no-op revocations', async () => {
  const owner = await db.user('Fan-out owner'),
    workspaceId = await db.workspace(owner.id);
  const scope = { workspaceId, actorId: owner.id };
  const organization = (
    await db.federation().createOrganization({
      ...scope,
      name: 'Maximum directory',
      idempotencyKey: randomUUID(),
    })
  ).organization;
  if (organization === null) throw new Error('Missing directory organization');
  const issued = await createDirectoryCredential(db.authenticationPool(), {
    ...scope,
    name: 'Measure',
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  if (issued.replayed) throw new Error('Fresh credential replayed');
  const principal = await authenticateDirectory(
    db.authenticationPool(),
    organization.id,
    createHash('sha256').update(issued.secret).digest('hex'),
  );
  const workspaces = [workspaceId];
  for (let index = 0; index < 9; index++) {
    const target = await db.workspace(owner.id);
    await db.federation().linkWorkspace({
      ...scope,
      targetWorkspaceId: target,
      defaultRole: 'viewer',
      expectedRevision: index + 2,
      idempotencyKey: randomUUID(),
    });
    workspaces.push(target);
  }
  const people = Array.from({ length: DIRECTORY_LIMITS.users }, () => ({
    id: randomUUID(),
    directoryId: randomUUID(),
  }));
  await db.asAdmin(
    `insert into app.users(id,email,email_verified,display_name,status)
    select id,id::text||'@fanout.test',true,'Fan-out person','active' from unnest($1::uuid[]) id`,
    [people.map((person) => person.id)],
  );
  await db.asAdmin(
    `insert into app.auth_directory_users(id,organization_id,user_id,user_name,normalized_user_name,login_email,profile)
    select directory_id,$1,user_id,user_id::text,user_id::text,user_id::text||'@fanout.test',
      jsonb_build_object('emails',jsonb_build_array(jsonb_build_object('value',user_id::text||'@fanout.test','primary',true)))
    from unnest($2::uuid[],$3::uuid[]) person(directory_id,user_id)`,
    [
      organization.id,
      people.map((person) => person.directoryId),
      people.map((person) => person.id),
    ],
  );
  await withDirectoryTransaction(
    db.authenticationPool(),
    principal,
    (client, current) => projectDirectoryMemberships(client, current),
  );
  const groups = Array.from({ length: DIRECTORY_LIMITS.groups }, () =>
    randomUUID(),
  );
  await db.asAdmin(
    `insert into app.auth_directory_groups(id,organization_id,display_name) select id,$1,'Group '||id::text from unnest($2::uuid[]) id`,
    [organization.id, groups],
  );
  const groupIds: string[] = [],
    userIds: string[] = [];
  for (const [index, groupId] of groups.entries())
    for (let member = 0; member < DIRECTORY_LIMITS.membersPerGroup; member++) {
      const person =
        people[
          (index * DIRECTORY_LIMITS.membersPerGroup + member) % people.length
        ];
      if (person === undefined)
        throw new Error('Missing maximum fixture member');
      groupIds.push(groupId);
      userIds.push(person.directoryId);
    }
  await db.asAdmin(
    'insert into app.auth_directory_group_members(organization_id,group_id,directory_user_id) select $1,group_id,user_id from unnest($2::uuid[],$3::uuid[]) member(group_id,user_id)',
    [organization.id, groupIds, userIds],
  );
  await db.asAdmin(
    `insert into app.auth_sessions(id,user_id,token,expires_at) select id,user_id,id::text,clock_timestamp()+interval '1 hour' from unnest($1::uuid[],$2::uuid[]) session(id,user_id)`,
    [people.map(() => randomUUID()), people.map((person) => person.id)],
  );
  const mappings = workspaces.flatMap((targetWorkspaceId) =>
    groups.map((groupId, priority) => ({
      workspaceId: targetWorkspaceId,
      groupId,
      priority,
      role: 'operator' as const,
    })),
  );
  const before = (
    await db.asAdmin<{ lsn: string }>('select pg_current_wal_lsn()::text lsn')
  )[0]?.lsn;
  const started = performance.now(),
    memoryBefore = process.memoryUsage().rss;
  await replaceDirectoryMappings(db.authenticationPool(), {
    ...scope,
    mappings,
    expectedRevision: 11,
    idempotencyKey: randomUUID(),
  });
  const elapsedMillis = Math.round(performance.now() - started),
    memoryAfter = process.memoryUsage().rss;
  const write = (
    await db.asAdmin<{ bytes: string }>(
      'select pg_wal_lsn_diff(pg_current_wal_lsn(),$1::pg_lsn)::bigint::text bytes',
      [before],
    )
  )[0]?.bytes;
  const counts = (
    await db.asAdmin<{
      members: number;
      sources: number;
      sessions: number;
      audits: number;
    }>(
      `select (select count(*)::integer from app.workspace_memberships where workspace_id=any($1::uuid[]) and role='operator' and status='active' and role_revision=2) members,
     (select count(*)::integer from app.auth_directory_memberships where organization_id=$2) sources,
     (select count(*)::integer from app.auth_sessions where user_id=any($3::uuid[])) sessions,
     (select count(*)::integer from app.audit_events where workspace_id=any($1::uuid[]) and action='identity.membership_projected') audits`,
      [workspaces, organization.id, people.map((person) => person.id)],
    )
  )[0];
  expect(counts).toEqual({
    members: 50000,
    sources: 50000,
    sessions: 0,
    audits: 50000,
  });
  await writeFile(
    '/tmp/pertexo-scim-directory-fanout.json',
    JSON.stringify(
      {
        users: people.length,
        workspaces: workspaces.length,
        groups: groups.length,
        groupMembers: groupIds.length,
        mappings: mappings.length,
        elapsedMillis,
        walBytes: write,
        residentGrowthBytes: memoryAfter - memoryBefore,
        counts,
      },
      null,
      2,
    ),
  );
  const person = people[0];
  if (person === undefined) throw new Error('Missing fixture person');
  await db.sessions(person.id);
  await replaceDirectoryMappings(db.authenticationPool(), {
    ...scope,
    mappings,
    expectedRevision: 12,
    idempotencyKey: randomUUID(),
  });
  expect(await db.liveSessions(person.id)).toBe(1);
  const unrelated = people[1];
  if (unrelated === undefined) throw new Error('Missing unrelated person');
  await db.sessions(unrelated.id);
  await db.asAdmin(
    'update app.auth_directory_users set active=false where id=any($1::uuid[])',
    [[person.directoryId, unrelated.directoryId]],
  );
  let returnedGroupMembers = 0;
  await withDirectoryTransaction(
    db.authenticationPool(),
    principal,
    async (client, current) => {
      const reader: {
        query(text: string, values?: unknown[]): Promise<QueryResult>;
      } = client;
      const queries = vi.spyOn(reader, 'query');
      try {
        await projectDirectoryMemberships(client, current, {}, [
          person.directoryId,
        ]);
        const replies: QueryResult[] = await Promise.all(
          queries.mock.results
            .filter((entry) => entry.type === 'return')
            .map((entry) => entry.value),
        );
        const groupRead = replies.find(
          (reply) =>
            reply.fields.length === 2 &&
            reply.fields.some((field) => field.name === 'group_id') &&
            reply.fields.some((field) => field.name === 'directory_user_id'),
        );
        returnedGroupMembers = groupRead?.rowCount ?? 0;
        expect(returnedGroupMembers).toBe(
          userIds.filter((id) => id === person.directoryId).length,
        );
        expect(returnedGroupMembers).toBe(20);
        for (const row of groupRead?.rows ?? [])
          expect(row).toMatchObject({ directory_user_id: person.directoryId });
      } finally {
        queries.mockRestore();
      }
    },
  );
  expect(
    await db.asAdmin(
      'select status,role_revision,count(*)::int count from app.workspace_memberships where workspace_id=any($1::uuid[]) and user_id=$2 group by status,role_revision',
      [workspaces, person.id],
    ),
  ).toEqual([{ status: 'removed', role_revision: 3, count: 10 }]);
  expect(
    await db.asAdmin(
      'select status,role_revision,count(*)::int count from app.workspace_memberships where workspace_id=any($1::uuid[]) and user_id=$2 group by status,role_revision',
      [workspaces, unrelated.id],
    ),
  ).toEqual([{ status: 'active', role_revision: 2, count: 10 }]);
  expect(await db.liveSessions(person.id)).toBe(0);
  expect(await db.liveSessions(unrelated.id)).toBe(1);
  await writeFile(
    '/tmp/pertexo-scim-directory-subset.json',
    JSON.stringify(
      {
        people: people.length,
        totalGroupMembers: groupIds.length,
        projectedPeople: 1,
        returnedGroupMembers,
        affectedWorkspaces: workspaces.length,
      },
      null,
      2,
    ),
  );
}, 60_000);
