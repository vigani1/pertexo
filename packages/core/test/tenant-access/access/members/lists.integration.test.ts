import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  WorkspaceAccessDeniedError,
  WorkspaceInvitationCommandConflictError,
} from '../../../../src/tenant-access/index.js';
import {
  admin,
  closeWorld,
  identities,
  invitation,
  openWorld,
  person,
  setStatus,
  team,
} from '../world.js';
import { LOST_ROLES, OUT_OF_SERVICE } from './support.js';

beforeAll(openWorld);
afterAll(closeWorld);

describe('the members list', () => {
  it.each(['owner', 'admin'] as const)('answers the %s', async (role) => {
    const world = await team();
    const page = await identities.listWorkspaceMembers(
      world.workspaceId,
      world[role],
    );
    expect(page.items.map(({ userId }) => userId).sort()).toEqual(
      [
        world.owner,
        world.admin,
        world.builder,
        world.operator,
        world.viewer,
      ].sort(),
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
