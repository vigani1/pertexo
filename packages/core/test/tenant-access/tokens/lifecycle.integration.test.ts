import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  beforeAllFixture1,
  afterAllFixture2,
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
  adminUrl,
  appUrl,
  maintenanceUrl,
  fixture,
} from './lifecycle/fixture.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { enforceRetention } from '../../support/retention.js';
import { purgeWorkspace } from '../../support/workspace-purge.js';

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
describe('persisted personal API tokens', () => {
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

  it('purges tokens before their owning memberships and scrubs their audit facts', async () => {
    const owner = await createOwner();
    await tokens.create({ ...input(), ...owner, idempotencyKey: randomUUID() });
    const steps = await purgeWorkspace({
      adminUrl: fixture.databaseUrl(adminUrl),
      maintenanceUrl: fixture.databaseUrl(maintenanceUrl),
      workspaceId: owner.workspaceId,
      pageSize: 1,
    });
    expect(steps).toContain('api_tokens');
    // Memberships go only when the purge finishes, after every row step.
    expect(
      (
        await admin.query(
          'select user_id from app.workspace_memberships where workspace_id=$1',
          [owner.workspaceId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await admin.query('select status from app.workspaces where id=$1', [
          owner.workspaceId,
        ])
      ).rows,
    ).toEqual([{ status: 'deleted' }]);
    expect(
      (
        await admin.query(
          'select id from app.api_tokens where workspace_id=$1',
          [owner.workspaceId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await admin.query(
          "select actor_user_id,metadata,target_id from app.audit_events where workspace_id=$1 and action='api.token.created'",
          [owner.workspaceId],
        )
      ).rows,
    ).toEqual([
      { actor_user_id: null, metadata: {}, target_id: owner.workspaceId },
    ]);
  });

  it('rejects workspace substitution, expiry and deletes terminal metadata through maintenance retention', async () => {
    const created = await tokens.create({
      ...input(),
      workspaceId,
      ownerUserId,
      idempotencyKey: randomUUID(),
    });
    if (created.replayed)
      throw new Error('First creation unexpectedly replayed');
    const credential = parsed(created.secret);
    const other = await createOwner();
    expect(
      await tokens.authenticate({
        ...credential,
        workspaceId: other.workspaceId,
      }),
    ).toBeUndefined();
    await admin.query(
      "update app.api_tokens set created_at=clock_timestamp()-interval '32 days', expires_at=clock_timestamp()-interval '31 days' where id=$1",
      [created.token.id],
    );
    expect(await tokens.authenticate(credential)).toBeUndefined();
    expect(
      (await enforceRetention(fixture.databaseUrl(maintenanceUrl), 1))
        .api_tokens,
    ).toBeGreaterThanOrEqual(1);
    expect(
      (
        await admin.query('select id from app.api_tokens where id=$1', [
          created.token.id,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it('forces workspace row isolation and refuses credential mutation through the app role', async () => {
    const isolated = await createOwner();
    const created = await tokens.create({
      ...input(),
      ...isolated,
      idempotencyKey: randomUUID(),
    });
    const app = new Pool({
      connectionString: fixture.databaseUrl(appUrl),
      max: 1,
    });
    try {
      expect((await app.query('select id from app.api_tokens')).rows).toEqual(
        [],
      );
      const client = await app.connect();
      try {
        await client.query('begin');
        await client.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        expect(
          (
            await client.query('select id from app.api_tokens where id=$1', [
              created.token.id,
            ])
          ).rowCount,
        ).toBe(0);
        await client.query('rollback');
        await client.query('begin');
        await client.query("select set_config('app.workspace_id',$1,true)", [
          isolated.workspaceId,
        ]);
        expect(
          (
            await client.query('select id from app.api_tokens where id=$1', [
              created.token.id,
            ])
          ).rowCount,
        ).toBe(1);
        await expect(
          client.query(
            "update app.api_tokens set secret_digest=repeat('a',64) where id=$1",
            [created.token.id],
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await client.query('rollback');
      } finally {
        client.release();
      }
    } finally {
      await app.end();
    }
  });

  // db-runs-02: ADR 013 step 2 revokes API keys; step 3 restores to `suspended`.
  it('revokes API tokens on deletion so a restore does not revive them', async () => {
    const owner = await createOwner();
    const created = await tokens.create({
      ...input(),
      ...owner,
      idempotencyKey: randomUUID(),
    });
    if (created.replayed)
      throw new Error('First creation unexpectedly replayed');
    const credential = parsed(created.secret);
    const lifecycle = (
      commandType: 'deletion_requested' | 'deletion_restored',
    ) =>
      identities.requestWorkspaceLifecycleOperation({
        workspaceId: owner.workspaceId,
        actorUserId: owner.ownerUserId,
        commandType,
        reason: 'Closing the workspace',
        idempotencyKey: randomUUID(),
      });

    await lifecycle('deletion_requested');
    const revoked = await admin.query<{ revoked: boolean }>(
      'select revoked_at is not null revoked from app.api_tokens where id=$1',
      [created.token.id],
    );
    expect(revoked.rows).toEqual([{ revoked: true }]);

    await lifecycle('deletion_restored');
    const workspace = await admin.query<{ status: string }>(
      'select status from app.workspaces where id=$1',
      [owner.workspaceId],
    );
    expect(workspace.rows).toEqual([{ status: 'suspended' }]);
    expect(await tokens.authenticate(credential)).toBeUndefined();
  });

  it('keeps revoked API tokens revoked after a reactivation', async () => {
    const owner = await createOwner();
    const created = await tokens.create({
      ...input(),
      ...owner,
      idempotencyKey: randomUUID(),
    });
    if (created.replayed)
      throw new Error('First creation unexpectedly replayed');
    const credential = parsed(created.secret);
    const lifecycle = (
      commandType: 'deletion_requested' | 'deletion_restored',
    ) =>
      identities.requestWorkspaceLifecycleOperation({
        workspaceId: owner.workspaceId,
        actorUserId: owner.ownerUserId,
        commandType,
        reason: 'Closing the workspace',
        idempotencyKey: randomUUID(),
      });
    await lifecycle('deletion_requested');
    await lifecycle('deletion_restored');

    await identities.requestWorkspaceLifecycleOperation({
      workspaceId: owner.workspaceId,
      actorUserId: owner.ownerUserId,
      commandType: 'reactivated',
      reason: 'Workspace reactivated',
      idempotencyKey: randomUUID(),
    });

    const workspace = await admin.query<{ status: string }>(
      'select status from app.workspaces where id=$1',
      [owner.workspaceId],
    );
    expect(workspace.rows).toEqual([{ status: 'active' }]);
    const revoked = await admin.query<{ revoked: boolean }>(
      'select revoked_at is not null revoked from app.api_tokens where id=$1',
      [created.token.id],
    );
    expect(revoked.rows).toEqual([{ revoked: true }]);
    expect(await tokens.authenticate(credential)).toBeUndefined();
  });
});
