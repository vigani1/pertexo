import { randomUUID } from 'node:crypto';

import { UNPURGED_WORKSPACE_STATUSES } from '@pertexo/workflow-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withWorkspaceAccess } from '../../../../src/shared/workspace-access.js';
import {
  admin,
  closeWorld,
  identities,
  invitation,
  join,
  openWorld,
  person,
  pool,
  setMembership,
  setUserStatus,
  team,
  tokens,
} from '../world.js';
import { answer, COMMANDS, key, membership, refusal } from './support.js';

beforeAll(openWorld);
afterAll(closeWorld);

describe('someone removed and someone who never belonged', () => {
  /** Each flow's whole answer, compared between the two. */
  const FLOWS: Readonly<
    Record<string, (workspaceId: string, actor: string) => Promise<unknown>>
  > = {
    ...COMMANDS,
    'members list': (workspaceId, actor) =>
      identities.listWorkspaceMembers(workspaceId, actor),
    'invitations list': (workspaceId, actor) =>
      identities.listWorkspaceInvitations(workspaceId, actor),
    'token list': (workspaceId, ownerUserId) =>
      tokens.list({ workspaceId, ownerUserId, limit: 5 }),
    'token create': (workspaceId, ownerUserId) =>
      tokens.create({
        workspaceId,
        ownerUserId,
        name: 'Runner',
        scopes: ['workflow:read'],
        expiresInDays: 30,
        ...key(),
      }),
    'token revoke': (workspaceId, ownerUserId) =>
      tokens.revoke({
        workspaceId,
        ownerUserId,
        tokenId: randomUUID(),
        ...key(),
      }),
    'ownership transfer': async (workspaceId, actorUserId) =>
      identities.transferWorkspaceOwnership({
        workspaceId,
        actorUserId,
        targetUserId: await join(workspaceId, 'admin'),
        expectedRoleRevision: 1,
        expectedOwnerRoleRevision: 1,
        ...key(),
      }),
    'helper change': (workspaceId, actorId) =>
      withWorkspaceAccess(
        pool,
        { workspaceId, actorId },
        {
          mode: 'change',
          capability: 'workspace:read',
          statuses: UNPURGED_WORKSPACE_STATUSES,
        },
        () => Promise.resolve(),
      ),
    'helper exclusive': (workspaceId, actorId) =>
      withWorkspaceAccess(
        pool,
        { workspaceId, actorId },
        {
          mode: 'exclusive',
          capability: 'workspace:read',
          statuses: UNPURGED_WORKSPACE_STATUSES,
        },
        () => Promise.resolve(),
      ),
    'helper read': (workspaceId, actorId) =>
      withWorkspaceAccess(
        pool,
        { workspaceId, actorId },
        {
          mode: 'read',
          capability: 'workspace:read',
          statuses: UNPURGED_WORKSPACE_STATUSES,
        },
        () => Promise.resolve(),
      ),
  };

  it.each(Object.entries(FLOWS))(
    'get the same refusal from %s',
    async (_name, flow) => {
      const { workspaceId } = await team();
      const removed = await join(workspaceId, 'admin');
      await setMembership(workspaceId, removed, 'removed');
      const stranger = await person();
      const answers = [
        await answer(flow(workspaceId, removed)),
        await answer(flow(workspaceId, stranger)),
      ];
      expect(answers[0]).not.toBe('answered');
      expect(answers[0]).toEqual(answers[1]);
    },
  );

  it('get the same class and reason from leaving, which is all the API answers from', async () => {
    const { workspaceId } = await team();
    const removed = await join(workspaceId, 'admin');
    await setMembership(workspaceId, removed, 'removed');
    const leave = (actorUserId: string) =>
      answer(identities.leaveWorkspace({ workspaceId, actorUserId, ...key() }));
    // The core messages differ, "Only active members can leave" and "The actor is
    // not a member". The API replaces both with fixed text for this reason.
    const expected = expect.objectContaining({
      error: 'WorkspaceMembershipCommandConflictError',
      reason: 'actor_inactive',
    }) as unknown;
    expect(await leave(removed)).toEqual(expected);
    expect(await leave(await person())).toEqual(expected);
  });
});

describe('someone whose standing changed', () => {
  const standings: readonly (readonly [
    string,
    (workspaceId: string, member: string) => Promise<void>,
  ])[] = [
    [
      'a suspended member',
      (workspaceId, member) => setMembership(workspaceId, member, 'suspended'),
    ],
    [
      'a suspended user',
      (_workspaceId, member) => setUserStatus(member, 'suspended'),
    ],
  ];

  it.each(standings)(
    '%s cannot make an invitation command',
    async (_who, change) => {
      const { workspaceId, owner, admin: manager } = await team();
      const created = await identities.createWorkspaceInvitation(
        invitation(workspaceId, owner),
      );
      await change(workspaceId, manager);
      for (const command of [
        identities.createWorkspaceInvitation(invitation(workspaceId, manager)),
        identities.revokeWorkspaceInvitation({
          workspaceId,
          actorUserId: manager,
          invitationId: created.invitation.id,
          expectedRevision: created.invitation.revision,
          ...key(),
        }),
      ])
        expect(await answer(command)).toEqual(refusal('actor_inactive'));
    },
  );

  it.each(standings)(
    '%s cannot change another member',
    async (_who, change) => {
      const { workspaceId, admin: manager, viewer } = await team();
      await change(workspaceId, manager);
      expect(
        await answer(
          identities.changeWorkspaceMemberRole({
            workspaceId,
            actorUserId: manager,
            targetUserId: viewer,
            role: 'builder',
            expectedRoleRevision: 1,
            ...key(),
          }),
        ),
      ).toEqual(refusal('actor_inactive'));
      expect(await membership(workspaceId, viewer)).toEqual({
        role: 'viewer',
        status: 'active',
      });
    },
  );

  it('an exact retry by someone since demoted is refused, not replayed', async () => {
    const { workspaceId, admin: manager, viewer } = await team();
    const command = {
      workspaceId,
      actorUserId: manager,
      targetUserId: viewer,
      role: 'builder' as const,
      expectedRoleRevision: 1,
      ...key(),
    };
    await identities.changeWorkspaceMemberRole(command);
    await admin.query(
      "update app.workspace_memberships set role='viewer' where workspace_id=$1 and user_id=$2",
      [workspaceId, manager],
    );
    expect(await answer(identities.changeWorkspaceMemberRole(command))).toEqual(
      refusal('actor_inactive'),
    );
  });
});
