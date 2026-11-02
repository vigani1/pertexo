import { randomUUID } from 'node:crypto';

import { UNPURGED_WORKSPACE_STATUSES } from '@pertexo/workflow-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withWorkspaceAccess } from '../../../src/shared/workspace-access.js';
import {
  WorkspaceAccessDeniedError,
  WorkspaceInvitationCommandConflictError,
  WorkspaceRenameCommandConflictError,
} from '../../../src/tenant-access/index.js';
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
  setStatus,
  setUserStatus,
  team,
  tokens,
  type WorkspaceStatus,
} from './world.js';

beforeAll(openWorld);
afterAll(closeWorld);

const LOST_ROLES = ['builder', 'operator', 'viewer'] as const;
const OUT_OF_SERVICE: readonly WorkspaceStatus[] = [
  'pending_deletion',
  'purging',
  'deleted',
];

/** What came back, so two people's answers can be compared whole. */
const answer = (work: Promise<unknown>) =>
  work.then(
    () => 'answered',
    (error: unknown) => {
      const { constructor, message, reason } = error as Error & {
        reason?: string;
      };
      return { error: constructor.name, reason, message };
    },
  );

const refusal = (reason: string) =>
  expect.objectContaining({ reason }) as unknown;

async function membership(workspaceId: string, userId: string) {
  const found = await admin.query<{ role: string; status: string }>(
    'select role,status from app.workspace_memberships where workspace_id=$1 and user_id=$2',
    [workspaceId, userId],
  );
  return found.rows[0];
}

async function auditCount(workspaceId: string, action: string) {
  const found = await admin.query<{ count: number }>(
    'select count(*)::int count from app.audit_events where workspace_id=$1 and action=$2',
    [workspaceId, action],
  );
  return found.rows[0]?.count;
}

async function receiptCount(workspaceId: string, operation: string) {
  const found = await admin.query<{ count: number }>(
    'select count(*)::int count from app.idempotency_records where workspace_id=$1 and operation=$2',
    [workspaceId, operation],
  );
  return found.rows[0]?.count;
}

const key = () => ({ idempotencyKey: randomUUID() });

/** Every command a member flow has, aimed at a viewer freshly added for it. */
const COMMANDS = {
  rename: (workspaceId: string, actorUserId: string) =>
    identities.renameWorkspace({
      workspaceId,
      actorUserId,
      name: `Renamed ${randomUUID()}`,
      expectedRevision: 1,
      ...key(),
    }),
  'role change': async (workspaceId: string, actorUserId: string) =>
    identities.changeWorkspaceMemberRole({
      workspaceId,
      actorUserId,
      targetUserId: await join(workspaceId, 'viewer'),
      role: 'builder',
      expectedRoleRevision: 1,
      ...key(),
    }),
  removal: async (workspaceId: string, actorUserId: string) =>
    identities.removeWorkspaceMember({
      workspaceId,
      actorUserId,
      targetUserId: await join(workspaceId, 'viewer'),
      expectedRoleRevision: 1,
      ...key(),
    }),
  suspension: async (workspaceId: string, actorUserId: string) =>
    identities.suspendWorkspaceMember({
      workspaceId,
      actorUserId,
      targetUserId: await join(workspaceId, 'viewer'),
      expectedRoleRevision: 1,
      ...key(),
    }),
  reactivation: async (workspaceId: string, actorUserId: string) =>
    identities.reactivateWorkspaceMember({
      workspaceId,
      actorUserId,
      targetUserId: await join(workspaceId, 'viewer', 'suspended'),
      expectedRoleRevision: 1,
      ...key(),
    }),
  'invitation create': (workspaceId: string, actorUserId: string) =>
    identities.createWorkspaceInvitation(invitation(workspaceId, actorUserId)),
} as const;
const COMMAND_NAMES = Object.keys(COMMANDS) as (keyof typeof COMMANDS)[];

describe('the members list', () => {
  it.each(['owner', 'admin'] as const)('answers the %s', async (role) => {
    const world = await team();
    const page = await identities.listWorkspaceMembers(
      world.workspaceId,
      world[role],
    );
    expect(page.items.map(({ userId }) => userId).sort()).toEqual(
      [world.owner, world.admin, world.builder, world.operator, world.viewer].sort(),
    );
  });

  it.each(LOST_ROLES)('denies a %s', async (role) => {
    const world = await team();
    await expect(
      identities.listWorkspaceMembers(world.workspaceId, world[role]),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });

  it('answers on a suspended workspace', async () => {
    const { workspaceId, owner } = await team();
    await setStatus(workspaceId, 'suspended');
    const page = await identities.listWorkspaceMembers(workspaceId, owner);
    expect(page.items.map(({ userId }) => userId)).toContain(owner);
  });

  it.each(OUT_OF_SERVICE)('denies even the owner on %s', async (status) => {
    const { workspaceId, owner } = await team();
    await setStatus(workspaceId, status);
    await expect(
      identities.listWorkspaceMembers(workspaceId, owner),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });
});

describe('the invitations list', () => {
  const expired = async (workspaceId: string, actor: string) => {
    const created = await identities.createWorkspaceInvitation(
      invitation(workspaceId, actor),
    );
    await admin.query(
      `update app.workspace_invitations set expires_at=clock_timestamp()-interval '1 minute' where id=$1`,
      [created.invitation.id],
    );
    return created.invitation.id;
  };

  const invitationStatus = async (id: string) =>
    (
      await admin.query<{ status: string }>(
        'select status from app.workspace_invitations where id=$1',
        [id],
      )
    ).rows[0]?.status;

  it.each(['owner', 'admin'] as const)('answers the %s', async (role) => {
    const world = await team();
    const created = await identities.createWorkspaceInvitation(
      invitation(world.workspaceId, world.owner),
    );
    const page = await identities.listWorkspaceInvitations(
      world.workspaceId,
      world[role],
    );
    expect(page.items.map(({ id }) => id)).toEqual([created.invitation.id]);
  });

  it('answers on a suspended workspace, and still writes the expiries it finds', async () => {
    const { workspaceId, owner } = await team();
    const id = await expired(workspaceId, owner);
    await setStatus(workspaceId, 'suspended');
    const page = await identities.listWorkspaceInvitations(workspaceId, owner);
    expect(page.items.map(({ status }) => status)).toEqual(['expired']);
    expect(await invitationStatus(id)).toBe('expired');
  });

  const refused: readonly (readonly [
    string,
    (world: Awaited<ReturnType<typeof team>>) => Promise<string>,
  ])[] = [
    ['a builder', (world) => Promise.resolve(world.builder)],
    ['an operator', (world) => Promise.resolve(world.operator)],
    ['a viewer', (world) => Promise.resolve(world.viewer)],
    ['an outsider', () => person()],
    [
      'the owner of a workspace pending deletion',
      async (world) => {
        await setStatus(world.workspaceId, 'pending_deletion');
        return world.owner;
      },
    ],
  ];

  it.each(refused)(
    'refuses %s as an inactive actor, never the raw denial, and expires nothing',
    async (_who, actor) => {
      const world = await team();
      const id = await expired(world.workspaceId, world.owner);
      const error: unknown = await identities
        .listWorkspaceInvitations(world.workspaceId, await actor(world))
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(WorkspaceInvitationCommandConflictError);
      expect(error).toMatchObject({ reason: 'actor_inactive' });
      expect(await invitationStatus(id)).toBe('pending');
    },
  );
});

describe('who can make a member command', () => {
  it.each(COMMAND_NAMES)('%s goes through for an owner and an admin', async (name) => {
    const world = await team();
    await expect(
      answer(COMMANDS[name](world.workspaceId, world.owner)),
    ).resolves.toBe('answered');
    const second = await team();
    await expect(
      answer(COMMANDS[name](second.workspaceId, second.admin)),
    ).resolves.toBe('answered');
  });

  it.each(
    COMMAND_NAMES.flatMap((name) => LOST_ROLES.map((role) => [name, role] as const)),
  )('%s is refused for a %s, and changes nothing', async (name, role) => {
    const world = await team();
    const revisionBefore = await admin.query(
      'select revision,name from app.workspaces where id=$1',
      [world.workspaceId],
    );
    expect(await answer(COMMANDS[name](world.workspaceId, world[role]))).toEqual(
      refusal('actor_inactive'),
    );
    const after = await admin.query(
      'select revision,name from app.workspaces where id=$1',
      [world.workspaceId],
    );
    expect(after.rows).toEqual(revisionBefore.rows);
    const changed = await admin.query(
      "select 1 from app.workspace_memberships where workspace_id=$1 and (role_revision>1 or status='removed')",
      [world.workspaceId],
    );
    expect(changed.rowCount).toBe(0);
    const invited = await admin.query(
      'select 1 from app.workspace_invitations where workspace_id=$1',
      [world.workspaceId],
    );
    expect(invited.rowCount).toBe(0);
  });
});

describe('member commands as a workspace leaves service', () => {
  it.each(
    COMMAND_NAMES.flatMap((name) =>
      (['suspended', ...OUT_OF_SERVICE] as const).map(
        (status) => [name, status] as const,
      ),
    ),
  )('%s is refused for the owner on %s', async (name, status) => {
    const { workspaceId, owner } = await team();
    await setStatus(workspaceId, status);
    expect(await answer(COMMANDS[name](workspaceId, owner))).toEqual(
      refusal(name === 'rename' ? 'workspace_inactive' : 'actor_inactive'),
    );
  });

  it.each(['suspended', ...OUT_OF_SERVICE] as const)(
    'refuses invitation revocation and resend on %s',
    async (status) => {
      const { workspaceId, owner } = await team();
      const created = await identities.createWorkspaceInvitation(
        invitation(workspaceId, owner),
      );
      await setStatus(workspaceId, status);
      const target = {
        workspaceId,
        actorUserId: owner,
        invitationId: created.invitation.id,
        expectedRevision: created.invitation.revision,
      };
      expect(
        await answer(
          identities.revokeWorkspaceInvitation({ ...target, ...key() }),
        ),
      ).toEqual(refusal('actor_inactive'));
      expect(
        await answer(
          identities.resendWorkspaceInvitation({
            ...target,
            ...key(),
            tokenDigest: randomUUID().replaceAll('-', '').repeat(2),
            sealedToken: invitation(workspaceId, owner).sealedToken,
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ),
      ).toEqual(refusal('actor_inactive'));
    },
  );
});

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

  it.each(Object.keys(FLOWS))('get the same refusal from %s', async (name) => {
    const flow = FLOWS[name] as (typeof FLOWS)[string];
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
  });

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
    ['a suspended user', (_workspaceId, member) => setUserStatus(member, 'suspended')],
  ];

  it.each(standings)('%s cannot make an invitation command', async (_who, change) => {
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
  });

  it.each(standings)('%s cannot change another member', async (_who, change) => {
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
  });

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

describe('a rename refused', () => {
  const rename = (
    workspaceId: string,
    actorUserId: string,
    expectedRevision = 1,
  ) =>
    identities.renameWorkspace({
      workspaceId,
      actorUserId,
      name: 'Should not stick',
      expectedRevision,
      ...key(),
    });

  async function expectNothingWritten(workspaceId: string) {
    const { rows } = await admin.query<{ name: string; revision: number }>(
      'select name,revision from app.workspaces where id=$1',
      [workspaceId],
    );
    expect(rows[0]?.name).not.toBe('Should not stick');
    expect(await auditCount(workspaceId, 'workspace.renamed')).toBe(0);
    expect(await receiptCount(workspaceId, 'workspace.rename')).toBe(0);
  }

  it('says workspace_inactive on a suspended workspace, and writes nothing', async () => {
    const { workspaceId, owner } = await team();
    await setStatus(workspaceId, 'suspended');
    const error: unknown = await rename(workspaceId, owner).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(WorkspaceRenameCommandConflictError);
    expect(error).toMatchObject({ reason: 'workspace_inactive' });
    await expectNothingWritten(workspaceId);
  });

  it('says actor_inactive to someone not managing it, and writes nothing', async () => {
    const { workspaceId, viewer } = await team();
    expect(await answer(rename(workspaceId, viewer))).toEqual(
      refusal('actor_inactive'),
    );
    await expectNothingWritten(workspaceId);
  });

  it('says revision_conflict on a stale revision, and writes nothing', async () => {
    const { workspaceId, owner } = await team();
    expect(await answer(rename(workspaceId, owner, 99))).toEqual(
      refusal('revision_conflict'),
    );
    await expectNothingWritten(workspaceId);
  });
});
