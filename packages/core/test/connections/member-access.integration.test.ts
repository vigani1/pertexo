import { describe, expect, it } from 'vitest';
import { ROLES } from '@pertexo/workflow-model';

import {
  ConnectionNotFoundError,
  ownerA,
  ownerB,
  randomUUID,
  workspaceA,
} from '../support/connections.js';
import {
  MEMBER_FLOWS,
  type MemberFlow,
  type Prepared,
} from './member-access/flows.js';
import {
  ROLE_MEMBERS,
  asDatabaseOwner,
  connections,
  expectNotVisible,
  newMember,
  registerMembers,
  restrictConnection,
  setMembership,
  stranger,
  suspendUser,
  whileWorkspaceIs,
} from './member-access/world.js';

registerMembers();

const FLOW_NAMES = MEMBER_FLOWS.map(({ name }) => name);

function flow(name: string): MemberFlow {
  const found = MEMBER_FLOWS.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`No flow named ${name}`);
  return found;
}

async function expectAnswered(prepared: Prepared): Promise<void> {
  prepared.done(await prepared.act(prepared.connectionId));
}

const USE_FLOWS = [
  'startConnectionTest',
  'resolveConnectionTestSecret',
  'markConnectionTestDispatched',
  'resolveConnectionLookupSecret',
].map(flow);

async function factsWrittenBy(actorId: string): Promise<number> {
  return asDatabaseOwner(workspaceA, async (client) => {
    const { rows } = await client.query<{ facts: number }>(
      `select (select count(*) from app.audit_events where actor_user_id=$1::uuid)::int
            + (select count(*) from app.connection_events where actor_id=$1::text)::int
              as facts`,
      [actorId],
    );
    return rows[0]?.facts ?? 0;
  });
}

describe('every connection flow with a member behind it', () => {
  it('is in this table, so a new flow has to say who may run it', () => {
    expect(FLOW_NAMES).toEqual([
      'createConnection',
      'findConnectionCreateReplay',
      'findConnectionRotateReplay',
      'rotateConnectionSecret',
      'revokeConnection',
      'readConnectionSharing',
      'replaceConnectionSharing',
      'readOAuth2Client',
      'startOAuth2Authorization',
      'listConnections',
      'readConnection',
      'listConnectionUsage',
      'startConnectionTest',
      'resolveConnectionTestSecret',
      'markConnectionTestDispatched',
      'resolveConnectionLookupSecret',
    ]);
  });

  describe.each(MEMBER_FLOWS)('$name', (subject) => {
    it.each(ROLES)('answers a %s as the role allows', async (role) => {
      const actorId = ROLE_MEMBERS[role];
      const prepared = await subject.prepare(actorId);
      if (subject.allowed.includes(role)) {
        prepared.done(await prepared.act(prepared.connectionId));
        return;
      }
      const before = await connections.api.getConnection(
        workspaceA,
        prepared.connectionId,
      );
      const factsBefore = await factsWrittenBy(actorId);
      await expectNotVisible(prepared.act(prepared.connectionId));
      expect(
        await connections.api.getConnection(workspaceA, prepared.connectionId),
      ).toEqual(before);
      expect(await factsWrittenBy(actorId)).toBe(factsBefore);
    });

    it('gives someone who lost access the answer someone who never had it gets', async () => {
      const lost = {
        removed: await newMember('admin', subject.name),
        suspended: await newMember('admin', subject.name),
        userSuspended: await newMember('admin', subject.name),
      };
      const attempts = {
        removed: await subject.prepare(lost.removed),
        suspended: await subject.prepare(lost.suspended),
        userSuspended: await subject.prepare(lost.userSuspended),
      };
      const never = await subject.prepare(stranger);
      const otherWorkspace = await subject.prepare(ownerB);
      await setMembership(lost.removed, { status: 'removed' });
      await setMembership(lost.suspended, { status: 'suspended' });
      await suspendUser(lost.userSuspended);

      await expectNotVisible(
        attempts.removed.act(attempts.removed.connectionId),
      );
      await expectNotVisible(
        attempts.suspended.act(attempts.suspended.connectionId),
      );
      await expectNotVisible(
        attempts.userSuspended.act(attempts.userSuspended.connectionId),
      );
      await expectNotVisible(never.act(never.connectionId));
      await expectNotVisible(otherWorkspace.act(otherWorkspace.connectionId));
      // Nothing tells a real connection from one that doesn't exist.
      await expectNotVisible(never.act(randomUUID()));
    });

    it('answers in a suspended workspace only if it just reads', async () => {
      const prepared = await subject.prepare(ownerA);
      await whileWorkspaceIs('suspended', async () => {
        if (subject.browsable)
          prepared.done(await prepared.act(prepared.connectionId));
        else await expectNotVisible(prepared.act(prepared.connectionId));
      });
    });

    it('never answers in a workspace pending deletion', async () => {
      const prepared = await subject.prepare(ownerA);
      await whileWorkspaceIs('pending_deletion', () =>
        expectNotVisible(prepared.act(prepared.connectionId)),
      );
    });
  });
});

describe('a restricted connection', () => {
  describe.each(USE_FLOWS)('$name', (subject) => {
    it('stays closed to a member without a share', async () => {
      const unshared = await newMember('builder', 'Unshared');
      const prepared = await subject.prepare(unshared);
      await restrictConnection(prepared.connectionId, []);
      await expectNotVisible(prepared.act(prepared.connectionId));
    });

    it('opens to a member with a share, and to an administrator', async () => {
      const shared = await newMember('builder', 'Shared');
      const forMember = await subject.prepare(shared);
      await restrictConnection(forMember.connectionId, [shared]);
      await expectAnswered(forMember);

      const forAdministrator = await subject.prepare(ROLE_MEMBERS.admin);
      await restrictConnection(forAdministrator.connectionId, []);
      await expectAnswered(forAdministrator);
    });
  });

  it('closes again when a share is taken away', async () => {
    const shared = await newMember('builder', 'Once shared');
    const prepared = await flow('resolveConnectionLookupSecret').prepare(
      shared,
    );
    await restrictConnection(prepared.connectionId, [shared]);
    prepared.done(await prepared.act(prepared.connectionId));
    await restrictConnection(prepared.connectionId, []);
    await expectNotVisible(prepared.act(prepared.connectionId));
  });

  it.each(['builder', 'viewer'] as const)(
    'stays out of what a %s without a share can read',
    async (role) => {
      const actorId = await newMember(role, 'Reader');
      const { connectionId } = await flow('readConnection').prepare(ownerA);
      await restrictConnection(connectionId, []);
      const ask = { workspaceId: workspaceA, actorId, connectionId };

      await expect(connections.api.readConnection(ask)).resolves.toBeNull();
      const { items } = await connections.api.listConnections({
        workspaceId: workspaceA,
        actorId,
        limit: 1,
      });
      expect(items.map(({ id }) => id)).not.toContain(connectionId);
      await expectNotVisible(connections.api.listConnectionUsage(ask));
      await expectNotVisible(
        connections.api.listConnectionUsage({
          ...ask,
          after: { workflowVersionId: randomUUID() },
        }),
      );
    },
  );

  it('shows its usage and refuses a made-up cursor for someone who can see it', async () => {
    const { connectionId } = await flow('readConnection').prepare(ownerA);
    await restrictConnection(connectionId, []);
    const ask = { workspaceId: workspaceA, actorId: ownerA, connectionId };
    await expect(
      connections.api.listConnectionUsage(ask),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      connections.api.listConnectionUsage({
        ...ask,
        after: { workflowVersionId: randomUUID() },
      }),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
  });
});
