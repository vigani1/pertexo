import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMemberships } from '../../../src/tenant-access/members/records.repository.js';
import type { MembershipAddition } from '../../../src/tenant-access/members/contract.js';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { useIdentityCommandDatabase } from '../command.support.js';

const db = useIdentityCommandDatabase('member_creation');
const facts = (workspaceId: string) =>
  db.asAdmin(
    "select actor_user_id,action,target_type,target_id,request_id,trace_id,metadata from app.audit_events where workspace_id=$1 and action='workspace.member_added' order by target_id",
    [workspaceId],
  );
async function setup() {
  const owner = await db.user('Membership owner');
  const workspaceId = await db.workspace(owner.id);
  const people = await Promise.all(
    ['Invited', 'JIT', 'Directory'].map((name) => db.user(name)),
  );
  const additions: MembershipAddition[] = people.map(
    (person, index): MembershipAddition => {
      if (index === 0) {
        return {
          userId: person.id,
          role: 'builder',
          source: 'invitation',
          invitationId: randomUUID(),
        };
      }
      if (index === 1) {
        return {
          userId: person.id,
          role: 'viewer',
          source: 'jit',
          organizationId: randomUUID(),
        };
      }
      return {
        userId: person.id,
        role: 'operator',
        source: 'directory',
        organizationId: randomUUID(),
        directoryUserId: randomUUID(),
        credentialId: randomUUID(),
      };
    },
  );
  return { owner, workspaceId, additions };
}
describe('membership creation and its canonical audit fact', () => {
  it('records workspace owner creation once through exact command replay', async () => {
    const owner = await db.user('New workspace owner');
    const input = {
      ownerUserId: owner.id,
      name: 'Created workspace',
      slug: `creation-${randomUUID()}`,
      idempotencyKey: randomUUID(),
      requestId: 'creation-request',
      traceId: 'creation-trace',
    };
    const first = await db.identity().createWorkspaceWithOwner(input);
    expect(await db.identity().createWorkspaceWithOwner(input)).toEqual(first);
    expect(await facts(first.id)).toEqual([
      {
        actor_user_id: owner.id,
        action: 'workspace.member_added',
        target_type: 'workspace_member',
        target_id: owner.id,
        request_id: input.requestId,
        trace_id: input.traceId,
        metadata: {
          source: 'workspace_creation',
          role: 'owner',
          status: 'active',
          roleRevision: 1,
        },
      },
    ]);
    expect(
      await db.asAdmin(
        "select count(*)::int count from app.audit_events where workspace_id=$1 and action='workspace.created'",
        [first.id],
      ),
    ).toEqual([{ count: 1 }]);
  });
  it('creates a mixed batch and gives each member the same bounded fact shape', async () => {
    const f = await setup();
    await withTenantScopedClient(
      db.authenticationPool(),
      { workspaceId: f.workspaceId, actorId: f.owner.id },
      (client) =>
        createMemberships(client, f.workspaceId, f.additions, {
          actorId: null,
          requestId: 'batch-request',
          traceId: 'batch-trace',
        }),
    );
    const created = (await facts(f.workspaceId)).filter(
      (fact) => fact.target_id !== f.owner.id,
    );
    expect(created).toEqual(
      f.additions
        .map(({ userId, ...details }) => ({
          actor_user_id: null,
          action: 'workspace.member_added',
          target_type: 'workspace_member',
          target_id: userId,
          request_id: 'batch-request',
          trace_id: 'batch-trace',
          metadata: { ...details, status: 'active', roleRevision: 1 },
        }))
        .sort((a, b) => (a.target_id < b.target_id ? -1 : 1)),
    );
    expect(
      await db.asAdmin(
        'select user_id,role,status,role_revision from app.workspace_memberships where workspace_id=$1 and user_id=any($2::uuid[]) order by user_id',
        [f.workspaceId, f.additions.map((member) => member.userId)],
      ),
    ).toEqual(
      f.additions
        .map((member) => ({
          user_id: member.userId,
          role: member.role,
          status: 'active',
          role_revision: 1,
        }))
        .sort((a, b) => (a.user_id < b.user_id ? -1 : 1)),
    );
  });
  it('records only the declared metadata when a structural member value carries private fields', async () => {
    const owner = await db.user('Creation owner'),
      workspaceId = await db.workspace(owner.id),
      person = await db.user('New member'),
      organizationId = randomUUID();
    const addition: MembershipAddition & { privatePayload: unknown } = {
      userId: person.id,
      role: 'viewer',
      source: 'jit',
      organizationId,
      privatePayload: { token: 'PRIVATE', runInput: ['PRIVATE'] },
    };
    await withTenantScopedClient(
      db.authenticationPool(),
      { workspaceId, actorId: owner.id },
      (client) =>
        createMemberships(client, workspaceId, [addition], {
          actorId: person.id,
        }),
    );
    expect(
      (await facts(workspaceId)).find((fact) => fact.target_id === person.id),
    ).toEqual({
      actor_user_id: person.id,
      action: 'workspace.member_added',
      target_type: 'workspace_member',
      target_id: person.id,
      request_id: null,
      trace_id: null,
      metadata: {
        role: 'viewer',
        source: 'jit',
        status: 'active',
        roleRevision: 1,
        organizationId,
      },
    });
  });
  it('rolls every insertion back when recording the facts fails', async () => {
    const f = await setup();
    await expect(
      withTenantScopedClient(
        db.authenticationPool(),
        { workspaceId: f.workspaceId, actorId: f.owner.id },
        (client) =>
          createMemberships(client, f.workspaceId, f.additions, {
            actorId: randomUUID(),
          }),
      ),
    ).rejects.toHaveProperty('code', '23503');
    expect(
      await db.asAdmin(
        'select user_id from app.workspace_memberships where workspace_id=$1 and user_id=any($2::uuid[])',
        [f.workspaceId, f.additions.map((member) => member.userId)],
      ),
    ).toEqual([]);
    expect(await facts(f.workspaceId)).toHaveLength(1);
  });
  it('keeps the insertion and fact inside the current workspace fence', async () => {
    const f = await setup(),
      otherWorkspaceId = await db.workspace(f.owner.id);
    await expect(
      withTenantScopedClient(
        db.authenticationPool(),
        { workspaceId: otherWorkspaceId, actorId: f.owner.id },
        (client) =>
          createMemberships(client, f.workspaceId, f.additions, {
            actorId: f.owner.id,
          }),
      ),
    ).rejects.toHaveProperty('code', '42501');
    expect(await facts(f.workspaceId)).toHaveLength(1);
    expect(await facts(otherWorkspaceId)).toHaveLength(1);
  });
});
