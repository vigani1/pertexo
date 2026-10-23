import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { enforceRetention } from '../../../support/retention.js';
import { purgeWorkspace } from '../../../support/workspace-purge.js';
import {
  adminUrl,
  appUrl,
  maintenanceUrl,
  fixture,
  admin,
  tokens,
  workspaceId,
  ownerUserId,
  input,
  parsed,
  createOwner,
} from './fixture.js';

export function registerPurgesTokensBeforeOwningMemberships(): void {
  it('purges tokens before their owning memberships and scrubs their audit facts', async () => {
    const owner = await createOwner();
    await tokens.create({ ...input(), ...owner, idempotencyKey: randomUUID() });
    const steps = await purgeWorkspace({
      adminUrl: fixture.databaseUrl(adminUrl),
      maintenanceUrl: fixture.databaseUrl(maintenanceUrl),
      workspaceId: owner.workspaceId,
      pageSize: 1,
    });
    expect(steps.indexOf('api_tokens')).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf('api_tokens')).toBeLessThan(
      steps.indexOf('workspace_memberships'),
    );
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
}
