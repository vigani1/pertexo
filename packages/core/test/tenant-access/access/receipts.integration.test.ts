import { createHash, randomUUID } from 'node:crypto';

import { IdempotencyConflictError } from '@pertexo/database/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  admin,
  closeWorld,
  identities,
  invitation,
  openWorld,
  team,
  tokens,
} from './world.js';

beforeAll(openWorld);
afterAll(closeWorld);

const isRealDate = (value: unknown) =>
  value instanceof Date && !Number.isNaN(value.getTime());

const key = () => ({ idempotencyKey: randomUUID() });

async function storedReceipt(
  workspaceId: string,
  operation: string,
  idempotencyKey: string,
) {
  const found = await admin.query<{
    id: string;
    request_hash: string;
    result_ref: unknown;
    status: string;
  }>(
    `select id,request_hash,result_ref,status from app.idempotency_records
      where workspace_id=$1 and operation=$2 and key_hash=$3`,
    [
      workspaceId,
      operation,
      createHash('sha256').update(idempotencyKey).digest('hex'),
    ],
  );
  const row = found.rows[0];
  if (row === undefined) throw new Error('No receipt was stored');
  return row;
}

const damage = (id: string, result: unknown) =>
  admin.query('update app.idempotency_records set result_ref=$2 where id=$1', [
    id,
    JSON.stringify(result),
  ]);

describe('an exact retry', () => {
  it('of a rename returns the first result with real dates, marked as replayed', async () => {
    const { workspaceId, owner } = await team();
    const command = {
      workspaceId,
      actorUserId: owner,
      name: 'Once',
      expectedRevision: 1,
      ...key(),
    };
    const first = await identities.renameWorkspace(command);
    const again = await identities.renameWorkspace(command);
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.changed).toBe(true);
    expect(again.workspace).toEqual(first.workspace);
    expect(isRealDate(again.workspace.createdAt)).toBe(true);
    expect(isRealDate(again.workspace.updatedAt)).toBe(true);
    await expect(
      identities.renameWorkspace({ ...command, name: 'Twice' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it.each(['create', 'revoke', 'resend'] as const)(
    'of an invitation %s returns the first result with real dates, marked as replayed',
    async (operation) => {
      const { workspaceId, owner } = await team();
      const create = invitation(workspaceId, owner);
      const created = await identities.createWorkspaceInvitation(create);
      if (operation !== 'create')
        // A resend waits for the first delivery to settle; nothing else differs.
        await admin.query(
          "update app.workspace_invitation_delivery_attempts set status='failed',failure_code='rejected' where invitation_id=$1",
          [created.invitation.id],
        );
      const target = {
        workspaceId,
        actorUserId: owner,
        invitationId: created.invitation.id,
        expectedRevision: 1,
        ...key(),
      };
      const command = {
        create: () => identities.createWorkspaceInvitation(create),
        revoke: () => identities.revokeWorkspaceInvitation(target),
        resend: () =>
          identities.resendWorkspaceInvitation({
            ...target,
            tokenDigest: randomUUID().replaceAll('-', '').repeat(2),
            sealedToken: create.sealedToken,
            expiresAt: new Date(Date.now() + 60_000),
          }),
      }[operation];
      const first = operation === 'create' ? created : await command();
      const again = await command();
      expect(again.replayed).toBe(true);
      expect(again.invitation.id).toBe(first.invitation.id);
      expect(again.invitation.status).toBe(first.invitation.status);
      for (const stamp of ['expiresAt', 'createdAt', 'updatedAt'] as const) {
        expect(isRealDate(again.invitation[stamp])).toBe(true);
        expect(again.invitation[stamp]).toEqual(first.invitation[stamp]);
      }
    },
  );

  it('of a member command returns the first result, marked as replayed', async () => {
    const { workspaceId, owner, viewer, operator, builder } = await team();
    const commands = [
      () =>
        identities.changeWorkspaceMemberRole({
          workspaceId,
          actorUserId: owner,
          targetUserId: viewer,
          role: 'builder',
          expectedRoleRevision: 1,
          idempotencyKey: 'role',
        }),
      () =>
        identities.removeWorkspaceMember({
          workspaceId,
          actorUserId: owner,
          targetUserId: operator,
          expectedRoleRevision: 1,
          idempotencyKey: 'removal',
        }),
      () =>
        identities.suspendWorkspaceMember({
          workspaceId,
          actorUserId: owner,
          targetUserId: builder,
          expectedRoleRevision: 1,
          idempotencyKey: 'suspension',
        }),
    ];
    for (const command of commands) {
      const first = await command();
      const again = await command();
      expect(first.replayed).toBe(false);
      expect(again).toEqual({ ...first, replayed: true });
    }
  });

  it('of a token create returns the same token and never the secret again', async () => {
    const { workspaceId, owner } = await team();
    const command = {
      workspaceId,
      ownerUserId: owner,
      name: 'Runner',
      scopes: ['workflow:read' as const],
      expiresInDays: 30,
      ...key(),
    };
    const first = await tokens.create(command);
    const again = await tokens.create(command);
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.token).toEqual(first.token);
    expect(again).not.toHaveProperty('secret');
    await expect(
      tokens.create({ ...command, name: 'Another' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

describe('a token create receipt written before the move to request:', () => {
  it('stores sha256 over canonical JSON, so an old receipt still matches', async () => {
    const { workspaceId, owner } = await team();
    const command = {
      workspaceId,
      ownerUserId: owner,
      name: 'Runner',
      scopes: ['run:read' as const, 'workflow:read' as const],
      expiresInDays: 30,
      ...key(),
    };
    const first = await tokens.create(command);
    const receipt = await storedReceipt(
      workspaceId,
      'api.token.create',
      command.idempotencyKey,
    );
    // Written out by hand: sorted keys, no spaces, scopes in the order given.
    const canonical =
      '{"expiresInDays":30,"name":"Runner","scopes":["run:read","workflow:read"]}';
    expect(receipt.request_hash).toBe(
      createHash('sha256').update(canonical).digest('hex'),
    );
    expect(receipt.result_ref).toEqual({ tokenId: first.token.id });
    await admin.query(
      'update app.idempotency_records set request_hash=$2 where id=$1',
      [receipt.id, createHash('sha256').update(canonical).digest('hex')],
    );
    await expect(tokens.create(command)).resolves.toMatchObject({
      replayed: true,
    });
  });
});

describe('a malformed stored receipt on replay', () => {
  /** A date the API's toISOString would throw on, or nothing at all. */
  const refusedAsUnreplayable = (work: () => Promise<unknown>) =>
    expect(work()).rejects.toBeInstanceOf(IdempotencyConflictError);

  it('of a rename is refused, never an invalid date or a crash', async () => {
    const { workspaceId, owner } = await team();
    const command = {
      workspaceId,
      actorUserId: owner,
      name: 'Once',
      expectedRevision: 1,
      ...key(),
    };
    const first = await identities.renameWorkspace(command);
    const receipt = await storedReceipt(
      workspaceId,
      'workspace.rename',
      command.idempotencyKey,
    );
    for (const malformed of [
      {
        changed: true,
        workspace: { ...first.workspace, createdAt: 'not a date' },
      },
      {
        changed: true,
        workspace: { ...first.workspace, updatedAt: 'not a date' },
      },
      { changed: true, workspace: { createdAt: first.workspace.createdAt } },
      {},
    ]) {
      await damage(receipt.id, malformed);
      await refusedAsUnreplayable(() => identities.renameWorkspace(command));
    }
    const { rows } = await admin.query<{ name: string; revision: number }>(
      'select name,revision from app.workspaces where id=$1',
      [workspaceId],
    );
    expect(rows).toEqual([{ name: 'Once', revision: 2 }]);
  });

  it('of an invitation is refused, never an invalid date or a crash', async () => {
    const { workspaceId, owner } = await team();
    const create = invitation(workspaceId, owner);
    const first = await identities.createWorkspaceInvitation(create);
    const receipt = await storedReceipt(
      workspaceId,
      'workspace.invitation.create',
      create.idempotencyKey,
    );
    for (const malformed of [
      { invitation: { ...first.invitation, expiresAt: 'not a date' } },
      { invitation: { id: first.invitation.id } },
      {},
    ]) {
      await damage(receipt.id, malformed);
      await refusedAsUnreplayable(() =>
        identities.createWorkspaceInvitation(create),
      );
    }
  });

  it('of a member command is refused, never a result with no member in it', async () => {
    const {
      workspaceId,
      owner,
      viewer,
      operator,
      builder,
      admin: second,
    } = await team();
    const commands: readonly (readonly [
      string,
      string,
      () => Promise<unknown>,
    ])[] = [
      [
        'workspace.member.role',
        'role',
        () =>
          identities.changeWorkspaceMemberRole({
            workspaceId,
            actorUserId: owner,
            targetUserId: viewer,
            role: 'builder',
            expectedRoleRevision: 1,
            idempotencyKey: 'role',
          }),
      ],
      [
        'workspace.member.removal',
        'removal',
        () =>
          identities.removeWorkspaceMember({
            workspaceId,
            actorUserId: owner,
            targetUserId: operator,
            expectedRoleRevision: 1,
            idempotencyKey: 'removal',
          }),
      ],
      [
        'workspace.member.suspension',
        'suspension',
        () =>
          identities.suspendWorkspaceMember({
            workspaceId,
            actorUserId: owner,
            targetUserId: builder,
            expectedRoleRevision: 1,
            idempotencyKey: 'suspension',
          }),
      ],
      [
        'workspace.member.departure',
        'departure',
        () =>
          identities.leaveWorkspace({
            workspaceId,
            actorUserId: second,
            idempotencyKey: 'departure',
          }),
      ],
    ];
    for (const [operation, idempotencyKey, command] of commands) {
      await command();
      const receipt = await storedReceipt(
        workspaceId,
        operation,
        idempotencyKey,
      );
      await damage(receipt.id, {});
      await refusedAsUnreplayable(command);
    }
  });

  it('of an ownership transfer is refused', async () => {
    const { workspaceId, owner, admin: successor } = await team();
    const command = {
      workspaceId,
      actorUserId: owner,
      targetUserId: successor,
      expectedRoleRevision: 1,
      expectedOwnerRoleRevision: 1,
      ...key(),
    };
    await identities.transferWorkspaceOwnership(command);
    // The old owner is an admin now, and so may still ask for the receipt.
    const receipt = await storedReceipt(
      workspaceId,
      'workspace.ownership.transfer',
      command.idempotencyKey,
    );
    await damage(receipt.id, {});
    await refusedAsUnreplayable(() =>
      identities.transferWorkspaceOwnership(command),
    );
  });

  it('of a token create is refused, and a token since gone reads as not found', async () => {
    const { workspaceId, owner } = await team();
    const command = {
      workspaceId,
      ownerUserId: owner,
      name: 'Runner',
      scopes: ['workflow:read' as const],
      expiresInDays: 30,
      ...key(),
    };
    await tokens.create(command);
    const receipt = await storedReceipt(
      workspaceId,
      'api.token.create',
      command.idempotencyKey,
    );
    for (const malformed of [{ tokenId: 'not-a-uuid' }, {}]) {
      await damage(receipt.id, malformed);
      await refusedAsUnreplayable(() => tokens.create(command));
    }
    await damage(receipt.id, { tokenId: randomUUID() });
    await expect(tokens.create(command)).rejects.toMatchObject({
      reason: 'not_found',
    });
  });
});
