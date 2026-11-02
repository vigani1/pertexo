import { randomUUID } from 'node:crypto';

import { withTenantScopedClient } from '@pertexo/database/primitives';
import { UNPURGED_WORKSPACE_STATUSES } from '@pertexo/workflow-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withWorkspaceAccess } from '../../../src/shared/workspace-access.js';
import {
  admin,
  closeWorld,
  gate,
  identities,
  invitation,
  join,
  openWorld,
  outcomes,
  person,
  pool,
  postgresCode,
  tokens,
  workspaceOwnedBy,
} from './world.js';

beforeAll(openWorld);
afterAll(closeWorld);

const anyMember = {
  capability: 'workspace:read',
  statuses: UNPURGED_WORKSPACE_STATUSES,
} as const;

/** Each command is set up in advance, so nothing refuses it for its own reasons. */
type Prepare = (
  workspaceId: string,
  actor: string,
) => Promise<() => Promise<unknown>>;

const COMMANDS: Readonly<Record<string, Prepare>> = {
  rename: (workspaceId, actor) =>
    Promise.resolve(() =>
      identities.renameWorkspace({
        workspaceId,
        actorUserId: actor,
        name: `Renamed ${randomUUID()}`,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ),
  'role change': async (workspaceId, actor) => {
    const target = await join(workspaceId, 'viewer');
    return () =>
      identities.changeWorkspaceMemberRole({
        workspaceId,
        actorUserId: actor,
        targetUserId: target,
        role: 'builder',
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      });
  },
  removal: async (workspaceId, actor) => {
    const target = await join(workspaceId, 'viewer');
    return () =>
      identities.removeWorkspaceMember({
        workspaceId,
        actorUserId: actor,
        targetUserId: target,
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      });
  },
  'invitation create': (workspaceId, actor) =>
    Promise.resolve(() =>
      identities.createWorkspaceInvitation(invitation(workspaceId, actor)),
    ),
  'invitation revoke': async (workspaceId, actor) => {
    const created = await identities.createWorkspaceInvitation(
      invitation(workspaceId, actor),
    );
    return () =>
      identities.revokeWorkspaceInvitation({
        workspaceId,
        actorUserId: actor,
        invitationId: created.invitation.id,
        expectedRevision: created.invitation.revision,
        idempotencyKey: randomUUID(),
      });
  },
  'token create': (workspaceId, actor) =>
    Promise.resolve(() =>
      tokens.create({
        workspaceId,
        ownerUserId: actor,
        name: 'Runner',
        scopes: ['workflow:read'],
        expiresInDays: 30,
        idempotencyKey: randomUUID(),
      }),
    ),
  'token revoke': async (workspaceId, actor) => {
    const created = await tokens.create({
      workspaceId,
      ownerUserId: actor,
      name: 'Runner',
      scopes: ['workflow:read'],
      expiresInDays: 30,
      idempotencyKey: randomUUID(),
    });
    return () =>
      tokens.revoke({
        workspaceId,
        ownerUserId: actor,
        tokenId: created.token.id,
        idempotencyKey: randomUUID(),
      });
  },
};

const SHARE_LOCK_FLOWS: Readonly<Record<string, Prepare>> = {
  'the members list': (workspaceId, actor) =>
    Promise.resolve(() => identities.listWorkspaceMembers(workspaceId, actor)),
  'the invitations list, which writes expiries': async (workspaceId, actor) => {
    const expiring = await identities.createWorkspaceInvitation(
      invitation(workspaceId, actor),
    );
    await admin.query(
      `update app.workspace_invitations set expires_at=clock_timestamp()-interval '1 minute' where id=$1`,
      [expiring.invitation.id],
    );
    return () => identities.listWorkspaceInvitations(workspaceId, actor);
  },
  'a change on the helper': (workspaceId, actor) =>
    Promise.resolve(() =>
      withWorkspaceAccess(
        pool,
        { workspaceId, actorId: actor },
        { mode: 'change', ...anyMember },
        () => Promise.resolve(),
      ),
    ),
  'an exclusive change on the helper': (workspaceId, actor) =>
    Promise.resolve(() =>
      withWorkspaceAccess(
        pool,
        { workspaceId, actorId: actor },
        { mode: 'exclusive', ...anyMember },
        () => Promise.resolve(),
      ),
    ),
};

const ROUNDS = 25;

async function everyoneFinishes(
  prepare: readonly Prepare[],
  actor: string,
): Promise<void> {
  const workspaces = await Promise.all(
    prepare.map(() => workspaceOwnedBy(actor)),
  );
  const work = await Promise.all(
    prepare.map((setUp, index) => setUp(workspaces[index] ?? '', actor)),
  );
  expect(await outcomes(work)).toEqual(work.map(() => 'done'));
}

describe('one person acting in many workspaces at once', () => {
  it.each(Object.keys(COMMANDS))(
    'runs %s beside itself and every other command without a deadlock',
    async (name) => {
      const command = COMMANDS[name] as Prepare;
      const actor = await person();
      for (let round = 0; round < ROUNDS; round += 1)
        await everyoneFinishes(
          [command, command, command, ...Object.values(COMMANDS)],
          actor,
        );
    },
    120_000,
  );

  it.each(Object.keys(SHARE_LOCK_FLOWS))(
    'runs %s, which takes share locks, beside every command without a deadlock',
    async (name) => {
      const flow = SHARE_LOCK_FLOWS[name] as Prepare;
      const actor = await person();
      for (let round = 0; round < ROUNDS; round += 1)
        await everyoneFinishes(
          [flow, flow, flow, flow, ...Object.values(COMMANDS)],
          actor,
        );
    },
    120_000,
  );
});

describe('everyone acting in one workspace at once', () => {
  it('serializes commands and share-lock flows without a deadlock', async () => {
    const owner = await person();
    for (let round = 0; round < ROUNDS; round += 1) {
      const workspaceId = await workspaceOwnedBy(owner);
      const manager = await join(workspaceId, 'admin');
      // Only one rename: a second would lose on its revision, not on a lock.
      const work = await Promise.all([
        ...Object.values(COMMANDS).map((setUp) => setUp(workspaceId, owner)),
        ...Object.entries(COMMANDS)
          .filter(([name]) => name !== 'rename')
          .map(([, setUp]) => setUp(workspaceId, manager)),
        ...Object.values(SHARE_LOCK_FLOWS).flatMap((setUp) => [
          setUp(workspaceId, owner),
          setUp(workspaceId, manager),
        ]),
      ]);
      expect(await outcomes(work)).toEqual(work.map(() => 'done'));
    }
  }, 120_000);

  it('survives two managers each changing the other, in both workspaces', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const first = await person();
      const second = await person();
      const left = await workspaceOwnedBy(first);
      const right = await workspaceOwnedBy(second);
      await admin.query(
        `insert into app.workspace_memberships(workspace_id,user_id,role) values($1,$3,'viewer'),($2,$4,'viewer')`,
        [left, right, second, first],
      );
      const change = (workspaceId: string, actor: string, target: string) => () =>
        identities.changeWorkspaceMemberRole({
          workspaceId,
          actorUserId: actor,
          targetUserId: target,
          role: 'builder',
          expectedRoleRevision: 1,
          idempotencyKey: randomUUID(),
        });
      expect(
        await outcomes([
          change(left, first, second),
          change(right, second, first),
        ]),
      ).toEqual(['done', 'done']);
    }
  }, 120_000);
});

describe('why these commands stay off the helper', () => {
  /** Each transaction holds its authority before either asks for the user. */
  async function bothHoldAuthority(
    mode: 'change' | 'exclusive',
    workspaces: readonly [string, string],
    actor: string,
  ) {
    let held = 0;
    const bothHeld = gate();
    const attempt = (workspaceId: string) =>
      withWorkspaceAccess(
        pool,
        { workspaceId, actorId: actor },
        { mode, ...anyMember },
        async (client) => {
          held += 1;
          if (held === 2) bothHeld.open();
          await bothHeld.opened;
          await client.query('select 1 from app.users where id=$1 for update', [
            actor,
          ]);
        },
      ).then(
        () => 'committed',
        (error: unknown) => postgresCode(error) ?? String(error),
      );
    return Promise.all(workspaces.map(attempt));
  }

  it.each(['exclusive', 'change'] as const)(
    "%s mode dies with 40P01 when two workspaces' commands then lock one user for update",
    async (mode) => {
      const actor = await person();
      const results = await bothHoldAuthority(
        mode,
        [await workspaceOwnedBy(actor), await workspaceOwnedBy(actor)],
        actor,
      );
      expect([...results].sort()).toEqual(['40P01', 'committed']);
    },
    30_000,
  );

  it('exclusive mode runs one at a time in one workspace, so that case alone is safe', async () => {
    const actor = await person();
    const workspaceId = await workspaceOwnedBy(actor);
    const attempt = () =>
      withWorkspaceAccess(
        pool,
        { workspaceId, actorId: actor },
        { mode: 'exclusive', ...anyMember },
        async (client) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          await client.query('select 1 from app.users where id=$1 for update', [
            actor,
          ]);
        },
      );
    expect(await outcomes([attempt, attempt, attempt])).toEqual([
      'done',
      'done',
      'done',
    ]);
  }, 30_000);

  it('taking the workspace and then the user for update, as the commands do, holds no lock to upgrade', async () => {
    const actor = await person();
    const left = await workspaceOwnedBy(actor);
    const right = await workspaceOwnedBy(actor);
    const start = gate();
    let ready = 0;
    const attempt = (workspaceId: string) => () =>
      withTenantScopedClient(
        pool,
        { workspaceId, actorId: actor },
        async (client) => {
          const locked = await client.query(
            'select 1 from app.workspaces where id=$1 for update',
            [workspaceId],
          );
          expect(locked.rowCount).toBe(1);
          ready += 1;
          if (ready === 2) start.open();
          await start.opened;
          const user = await client.query(
            'select 1 from app.users where id=$1 for update',
            [actor],
          );
          expect(user.rowCount).toBe(1);
        },
      );
    expect(await outcomes([attempt(left), attempt(right)])).toEqual([
      'done',
      'done',
    ]);
  }, 30_000);
});
