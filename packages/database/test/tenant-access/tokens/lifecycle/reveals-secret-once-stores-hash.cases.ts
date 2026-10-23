import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  admin,
  identities,
  tokens,
  workspaceId,
  ownerUserId,
  builderUserId,
  input,
  parsed,
  createOwner,
  restartTokenRepository,
} from './fixture.js';

export function registerRevealsSecretOnceStoresHash(): void {
  it('reveals the secret once, stores a hash and safe receipt, survives restart, and revokes', async () => {
    const command = {
      ...input(),
      workspaceId,
      ownerUserId,
      idempotencyKey: randomUUID(),
    };
    const created = await tokens.create(command);
    if (created.replayed)
      throw new Error('First creation unexpectedly replayed');
    const credential = parsed(created.secret);
    const again = await tokens.create(command);
    expect(again.replayed).toBe(true);
    expect(again.token.id).toBe(created.token.id);
    expect(again).not.toHaveProperty('secret');
    const stored = await admin.query<{ secret_digest: string }>(
      'select * from app.api_tokens where id=$1',
      [created.token.id],
    );
    expect(stored.rows[0]?.secret_digest).toBe(credential.digest);
    const receipts = await admin.query(
      'select result_ref from app.idempotency_records where resource_id=$1',
      [created.token.id],
    );
    const audit = await admin.query(
      'select metadata from app.audit_events where target_id=$1',
      [created.token.id],
    );
    expect(
      JSON.stringify([stored.rows, receipts.rows, audit.rows]),
    ).not.toContain(created.secret);
    expect(JSON.stringify([receipts.rows, audit.rows])).not.toContain(
      credential.digest,
    );
    await restartTokenRepository();
    expect(await tokens.authenticate(credential)).toMatchObject({
      ownerUserId,
      workspaceId,
      tokenId: created.token.id,
    });
    const firstUse = await admin.query<{ last_used_at: Date }>(
      'select last_used_at from app.api_tokens where id=$1',
      [created.token.id],
    );
    await tokens.authenticate(credential);
    const secondUse = await admin.query<{ last_used_at: Date }>(
      'select last_used_at from app.api_tokens where id=$1',
      [created.token.id],
    );
    expect(secondUse.rows[0]?.last_used_at).toEqual(
      firstUse.rows[0]?.last_used_at,
    );
    const revoke = {
      workspaceId,
      ownerUserId,
      tokenId: created.token.id,
      idempotencyKey: randomUUID(),
    };
    expect((await tokens.revoke(revoke)).token.status).toBe('revoked');
    expect((await tokens.revoke(revoke)).replayed).toBe(true);
    expect(await tokens.authenticate(credential)).toBeUndefined();
    await restartTokenRepository();
    expect(await tokens.authenticate(credential)).toBeUndefined();
  });

  it('keeps owner metadata private and denies current-role escalation', async () => {
    const created = await tokens.create({
      ...input(),
      workspaceId,
      ownerUserId,
      idempotencyKey: randomUUID(),
    });
    const builder = { workspaceId, ownerUserId: builderUserId };
    expect((await tokens.list({ ...builder, limit: 25 })).items).toEqual([]);
    await expect(
      tokens.revoke({
        ...builder,
        tokenId: created.token.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'not_found' });
    await expect(
      tokens.create({
        ...builder,
        ...input(),
        scopes: ['run:cancel'],
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'scope_forbidden' });
  });

  it('does not revive an earlier grant after role changes back', async () => {
    const created = await tokens.create({
      ...input(),
      workspaceId,
      ownerUserId: builderUserId,
      idempotencyKey: randomUUID(),
    });
    if (created.replayed)
      throw new Error('First creation unexpectedly replayed');
    const credential = parsed(created.secret);
    await identities.changeWorkspaceMemberRole({
      workspaceId,
      actorUserId: ownerUserId,
      targetUserId: builderUserId,
      role: 'viewer',
      expectedRoleRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(await tokens.authenticate(credential)).toBeUndefined();
    await identities.changeWorkspaceMemberRole({
      workspaceId,
      actorUserId: ownerUserId,
      targetUserId: builderUserId,
      role: 'builder',
      expectedRoleRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(await tokens.authenticate(credential)).toBeUndefined();
    expect(
      (
        await tokens.list({
          workspaceId,
          ownerUserId: builderUserId,
          limit: 25,
        })
      ).items.find((token) => token.id === created.token.id)?.status,
    ).toBe('membership_changed');
  });

  it('serializes competing issuance at ten usable credentials', async () => {
    const owner = await createOwner();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        tokens.create({ ...input(), ...owner, idempotencyKey: randomUUID() }),
      ),
    );
    expect(
      outcomes.filter((value) => value.status === 'fulfilled'),
    ).toHaveLength(10);
    const rejected = outcomes.filter((value) => value.status === 'rejected');
    expect(rejected).toHaveLength(2);
    for (const value of rejected)
      expect(value.reason).toMatchObject({ reason: 'token_limit' });
    const page = await tokens.list({ ...owner, limit: 6 });
    expect(page.items).toHaveLength(6);
    if (page.nextCursor === null) throw new Error('Missing next page');
    expect(
      (await tokens.list({ ...owner, limit: 6, after: page.nextCursor })).items,
    ).toHaveLength(4);
  });

  it('invalidates grants across suspension/reactivation and ownership transfer', async () => {
    const owner = await createOwner();
    const member = await identities.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Automation administrator',
    });
    await admin.query(
      "insert into app.workspace_memberships(workspace_id,user_id,role) values($1,$2,'admin')",
      [owner.workspaceId, member.id],
    );
    const memberOwner = { ...owner, ownerUserId: member.id };
    const create = async (authority: typeof owner) => {
      const result = await tokens.create({
        ...input(),
        ...authority,
        idempotencyKey: randomUUID(),
      });
      if (result.replayed)
        throw new Error('First creation unexpectedly replayed');
      return parsed(result.secret);
    };
    const beforeSuspension = await create(memberOwner);
    const command = {
      workspaceId: owner.workspaceId,
      actorUserId: owner.ownerUserId,
      targetUserId: member.id,
    };
    await identities.suspendWorkspaceMember({
      ...command,
      expectedRoleRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(await tokens.authenticate(beforeSuspension)).toBeUndefined();
    await identities.reactivateWorkspaceMember({
      ...command,
      expectedRoleRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(await tokens.authenticate(beforeSuspension)).toBeUndefined();
    const [beforeTransfer, previousOwner] = await Promise.all([
      create(memberOwner),
      create(owner),
    ]);
    await identities.transferWorkspaceOwnership({
      ...command,
      expectedRoleRevision: 3,
      expectedOwnerRoleRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(await tokens.authenticate(beforeTransfer)).toBeUndefined();
    expect(await tokens.authenticate(previousOwner)).toBeUndefined();
    expect(await tokens.authenticate(await create(memberOwner))).toBeDefined();
  });
}
