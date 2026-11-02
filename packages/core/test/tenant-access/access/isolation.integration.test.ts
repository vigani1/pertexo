import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@pertexo/database/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withWorkspaceAccess } from '../../../src/shared/workspace-access.js';
import { UNPURGED_WORKSPACE_STATUSES } from '@pertexo/workflow-model';
import { createGovernanceStore } from '../../../src/governance/store.js';
import { WorkflowRunNotFoundError } from '../../../src/runs/errors.js';
import {
  WorkspaceAccessDeniedError,
  WorkspaceInvitationCommandConflictError,
} from '../../../src/tenant-access/index.js';
import { createWorkspaceVariablesStore } from '../../../src/variables/store.js';
import {
  admin,
  appDatabaseUrl,
  closeWorld,
  identities,
  invitation,
  openWorld,
  pool,
  runs,
  seedRun,
  team,
  tokens,
} from './world.js';

beforeAll(openWorld);
afterAll(closeWorld);

const key = () => ({ idempotencyKey: randomUUID() });
const config = parseDatabaseConfig({
  connectionString: appDatabaseUrl,
  max: 2,
});

/** Everything in a workspace an outsider must not be able to see or change. */
async function fingerprint(workspaceId: string) {
  const read = async (table: string) =>
    (
      await admin.query(
        `select to_jsonb(t) row from app.${table} t where workspace_id=$1 order by 1::text`,
        [workspaceId],
      )
    ).rows;
  return {
    workspace: (
      await admin.query(
        'select name,revision,status from app.workspaces where id=$1',
        [workspaceId],
      )
    ).rows,
    members: await read('workspace_memberships'),
    invitations: await read('workspace_invitations'),
    tokens: await read('api_tokens'),
    runs: await read('workflow_runs'),
  };
}

async function twoWorkspaces() {
  const mine = await team();
  const theirs = await team();
  const run = await seedRun(theirs.workspaceId, theirs.owner, 'queued');
  const pending = await identities.createWorkspaceInvitation(
    invitation(theirs.workspaceId, theirs.owner),
  );
  const token = await tokens.create({
    workspaceId: theirs.workspaceId,
    ownerUserId: theirs.owner,
    name: 'Theirs',
    scopes: ['workflow:read'],
    expiresInDays: 30,
    ...key(),
  });
  return { mine, theirs, run, pending, token };
}

type World = Awaited<ReturnType<typeof twoWorkspaces>>;

describe('an owner of one workspace, reaching into another by its id', () => {
  const REFUSED: readonly (readonly [
    string,
    (world: World) => Promise<unknown>,
    object,
  ])[] = [
    [
      'the members list',
      ({ mine, theirs }) =>
        identities.listWorkspaceMembers(theirs.workspaceId, mine.owner),
      WorkspaceAccessDeniedError,
    ],
    [
      'the invitations list',
      ({ mine, theirs }) =>
        identities.listWorkspaceInvitations(theirs.workspaceId, mine.owner),
      WorkspaceInvitationCommandConflictError,
    ],
    [
      'a run command',
      ({ mine, theirs, run }) =>
        runs.cancel({
          workspaceId: theirs.workspaceId,
          actorId: mine.owner,
          runId: run.runId,
          reason: 'No',
        }),
      WorkflowRunNotFoundError,
    ],
  ];

  it.each(REFUSED)('is refused %s', async (_flow, reach, error) => {
    const world = await twoWorkspaces();
    const before = await fingerprint(world.theirs.workspaceId);
    await expect(reach(world)).rejects.toBeInstanceOf(error);
    expect(await fingerprint(world.theirs.workspaceId)).toEqual(before);
  });

  const COMMANDS: readonly (readonly [
    string,
    (world: World) => Promise<unknown>,
    string,
  ])[] = [
    [
      'a rename',
      ({ mine, theirs }) =>
        identities.renameWorkspace({
          workspaceId: theirs.workspaceId,
          actorUserId: mine.owner,
          name: 'Taken over',
          expectedRevision: 1,
          ...key(),
        }),
      'actor_inactive',
    ],
    [
      'a role change',
      ({ mine, theirs }) =>
        identities.changeWorkspaceMemberRole({
          workspaceId: theirs.workspaceId,
          actorUserId: mine.owner,
          targetUserId: theirs.viewer,
          role: 'admin',
          expectedRoleRevision: 1,
          ...key(),
        }),
      'actor_inactive',
    ],
    [
      'a removal',
      ({ mine, theirs }) =>
        identities.removeWorkspaceMember({
          workspaceId: theirs.workspaceId,
          actorUserId: mine.owner,
          targetUserId: theirs.viewer,
          expectedRoleRevision: 1,
          ...key(),
        }),
      'actor_inactive',
    ],
    [
      'an ownership transfer',
      ({ mine, theirs }) =>
        identities.transferWorkspaceOwnership({
          workspaceId: theirs.workspaceId,
          actorUserId: mine.owner,
          targetUserId: mine.owner,
          expectedRoleRevision: 1,
          expectedOwnerRoleRevision: 1,
          ...key(),
        }),
      'actor_inactive',
    ],
    [
      'an invitation',
      ({ mine, theirs }) =>
        identities.createWorkspaceInvitation(
          invitation(theirs.workspaceId, mine.owner),
        ),
      'actor_inactive',
    ],
    [
      'revoking an invitation',
      ({ mine, theirs, pending }) =>
        identities.revokeWorkspaceInvitation({
          workspaceId: theirs.workspaceId,
          actorUserId: mine.owner,
          invitationId: pending.invitation.id,
          expectedRevision: 1,
          ...key(),
        }),
      'actor_inactive',
    ],
    [
      'listing tokens',
      ({ mine, theirs }) =>
        tokens.list({
          workspaceId: theirs.workspaceId,
          ownerUserId: mine.owner,
          limit: 5,
        }),
      'authority_inactive',
    ],
    [
      'creating a token',
      ({ mine, theirs }) =>
        tokens.create({
          workspaceId: theirs.workspaceId,
          ownerUserId: mine.owner,
          name: 'Mine now',
          scopes: ['workflow:read'],
          expiresInDays: 30,
          ...key(),
        }),
      'authority_inactive',
    ],
    [
      'revoking a token',
      ({ mine, theirs, token }) =>
        tokens.revoke({
          workspaceId: theirs.workspaceId,
          ownerUserId: mine.owner,
          tokenId: token.token.id,
          ...key(),
        }),
      'authority_inactive',
    ],
  ];

  it.each(COMMANDS)(
    'is refused %s, and nothing changes',
    async (_flow, reach, reason) => {
      const world = await twoWorkspaces();
      const before = await fingerprint(world.theirs.workspaceId);
      await expect(reach(world)).rejects.toMatchObject({ reason });
      expect(await fingerprint(world.theirs.workspaceId)).toEqual(before);
    },
  );

  it('reads no rows of it, even with the helper open on its own workspace', async () => {
    const { mine, theirs, run } = await twoWorkspaces();
    const seen = await withWorkspaceAccess(
      pool,
      { workspaceId: mine.workspaceId, actorId: mine.owner },
      {
        mode: 'read',
        capability: 'workspace:read',
        statuses: UNPURGED_WORKSPACE_STATUSES,
      },
      async (client) => ({
        runs: (
          await client.query('select id from app.workflow_runs where id=$1', [
            run.runId,
          ])
        ).rowCount,
        members: (
          await client.query(
            'select 1 from app.workspace_memberships where workspace_id=$1',
            [theirs.workspaceId],
          )
        ).rowCount,
      }),
    );
    expect(seen).toEqual({ runs: 0, members: 0 });
  });
});

describe('aiming at another workspace’s things through your own', () => {
  it('cannot change their member', async () => {
    const { mine, theirs } = await twoWorkspaces();
    await expect(
      identities.changeWorkspaceMemberRole({
        workspaceId: mine.workspaceId,
        actorUserId: mine.owner,
        targetUserId: theirs.viewer,
        role: 'builder',
        expectedRoleRevision: 1,
        ...key(),
      }),
    ).rejects.toMatchObject({ reason: 'target_missing' });
  });

  it('cannot reach their invitation', async () => {
    const { mine, theirs, pending } = await twoWorkspaces();
    const before = await fingerprint(theirs.workspaceId);
    await expect(
      identities.revokeWorkspaceInvitation({
        workspaceId: mine.workspaceId,
        actorUserId: mine.owner,
        invitationId: pending.invitation.id,
        expectedRevision: 1,
        ...key(),
      }),
    ).rejects.toMatchObject({ reason: 'invitation_missing' });
    expect(await fingerprint(theirs.workspaceId)).toEqual(before);
  });

  it('cannot reach their token', async () => {
    const { mine, theirs, token } = await twoWorkspaces();
    const before = await fingerprint(theirs.workspaceId);
    await expect(
      tokens.revoke({
        workspaceId: mine.workspaceId,
        ownerUserId: mine.owner,
        tokenId: token.token.id,
        ...key(),
      }),
    ).rejects.toMatchObject({ reason: 'not_found' });
    expect(await fingerprint(theirs.workspaceId)).toEqual(before);
  });

  it('does not list their token, or a colleague’s, among your own', async () => {
    const { mine, theirs, token } = await twoWorkspaces();
    expect(
      (
        await tokens.list({
          workspaceId: mine.workspaceId,
          ownerUserId: mine.owner,
          limit: 50,
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await tokens.list({
          workspaceId: theirs.workspaceId,
          ownerUserId: theirs.admin,
          limit: 50,
        })
      ).items.map(({ id }) => id),
    ).not.toContain(token.token.id);
  });

  it('does not list their members or invitations among your own', async () => {
    const { mine, theirs, pending } = await twoWorkspaces();
    const members = await identities.listWorkspaceMembers(
      mine.workspaceId,
      mine.owner,
    );
    expect(members.items.map(({ userId }) => userId)).not.toContain(
      theirs.owner,
    );
    const invitations = await identities.listWorkspaceInvitations(
      mine.workspaceId,
      mine.owner,
    );
    expect(invitations.items.map(({ id }) => id)).not.toContain(
      pending.invitation.id,
    );
  });
});

describe('other areas on the helper, one for each mode', () => {
  it('refuses an outsider a read, a change and an exclusive change', async () => {
    const { mine, theirs } = await twoWorkspaces();
    const variables = createWorkspaceVariablesStore(config);
    const governance = createGovernanceStore(config);
    try {
      const actor = { workspaceId: theirs.workspaceId, actorId: mine.owner };
      await expect(variables.read(actor)).rejects.toBeInstanceOf(
        WorkspaceAccessDeniedError,
      );
      await expect(
        variables.replace({
          ...actor,
          values: {},
          descriptions: {},
          expectedRevision: 1,
          ...key(),
        }),
      ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
      await expect(
        governance.configure({ ...actor, expectedRevision: 1, ...key() }),
      ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    } finally {
      await Promise.all([variables.close(), governance.close()]);
    }
  });
});
