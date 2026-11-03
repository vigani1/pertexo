import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkspaceRenameCommandConflictError } from '../../../../src/tenant-access/index.js';
import {
  admin,
  closeWorld,
  identities,
  invitation,
  openWorld,
  setStatus,
  team,
} from '../world.js';
import {
  answer,
  auditCount,
  COMMAND_NAMES,
  COMMANDS,
  key,
  LOST_ROLES,
  OUT_OF_SERVICE,
  receiptCount,
  refusal,
} from './support.js';

beforeAll(openWorld);
afterAll(closeWorld);

describe('who can make a member command', () => {
  it.each(COMMAND_NAMES)(
    '%s enforces the owner’s and admin’s command grants',
    async (name) => {
      const world = await team();
      await expect(
        answer(COMMANDS[name](world.workspaceId, world.owner)),
      ).resolves.toBe('answered');
      const second = await team();
      await expect(
        answer(COMMANDS[name](second.workspaceId, second.admin)),
      ).resolves.toEqual(
        name === 'rename' ? refusal('actor_inactive') : 'answered',
      );
    },
  );

  it.each(
    COMMAND_NAMES.flatMap((name) =>
      LOST_ROLES.map((role) => [name, role] as const),
    ),
  )('%s is refused for a %s, and changes nothing', async (name, role) => {
    const world = await team();
    const revisionBefore = await admin.query(
      'select revision,name from app.workspaces where id=$1',
      [world.workspaceId],
    );
    expect(
      await answer(COMMANDS[name](world.workspaceId, world[role])),
    ).toEqual(refusal('actor_inactive'));
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
          }),
        ),
      ).toEqual(refusal('actor_inactive'));
    },
  );
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
