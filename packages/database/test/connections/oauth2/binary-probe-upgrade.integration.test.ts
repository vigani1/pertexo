import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { expect, it } from 'vitest';

import { connectionOAuth2Authorizations } from '../../../src/schema.js';
import {
  seedOAuth2Connection,
  seedWorkspace,
} from '../../../src/testing/connections/oauth2/fixture.js';
import { withUpgradeDatabase } from '../../platform/migrations/upgrade-fixture.js';

it('removes a populated test probe while retaining real tenant records and raw OAuth bytes', async () => {
  await withUpgradeDatabase(82, async ({ admin, upgrade }) => {
    const workspace = await seedWorkspace(admin);
    const connection = await seedOAuth2Connection(admin, workspace);
    const stateDigest = Buffer.from(
      Array.from({ length: 32 }, (_, index) => index * 8),
    );
    const bindingDigest = Buffer.from(stateDigest).reverse();
    const db = drizzle(admin);
    await db
      .update(connectionOAuth2Authorizations)
      .set({ stateDigest, bindingDigest })
      .where(
        eq(
          connectionOAuth2Authorizations.connectionId,
          connection.connectionId,
        ),
      );
    const readBytes = () =>
      db
        .select({
          state: connectionOAuth2Authorizations.stateDigest,
          binding: connectionOAuth2Authorizations.bindingDigest,
        })
        .from(connectionOAuth2Authorizations)
        .where(
          eq(
            connectionOAuth2Authorizations.connectionId,
            connection.connectionId,
          ),
        );
    expect(await readBytes()).toEqual([
      { state: stateDigest, binding: bindingDigest },
    ]);
    await admin.query(
      'insert into app.rls_probe_records(id,workspace_id,label) values($1,$2,$3)',
      [randomUUID(), workspace.workspaceId, 'retired probe'],
    );
    const record = randomUUID();
    await admin.query(
      `insert into app.idempotency_records(id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref,expires_at)
      values($1,$2,'test.upgrade','upgrade',$3,$3,'completed',$1,'{"retained":true}',clock_timestamp()+interval '1 day')`,
      [record, workspace.workspaceId, 'a'.repeat(64)],
    );
    const readRecord = async () =>
      (
        await admin.query<Record<string, unknown>>(
          'select to_jsonb(i) row from app.idempotency_records i where id=$1',
          [record],
        )
      ).rows;
    const before = await readRecord();
    expect(await upgrade(83)).toEqual(['0083_remove_test_probe.sql']);
    expect(
      (
        await admin.query(
          "select to_regclass('app.rls_probe_records') relation",
        )
      ).rows,
    ).toEqual([{ relation: null }]);
    expect(await readRecord()).toEqual(before);
    expect(await readBytes()).toEqual([
      { state: stateDigest, binding: bindingDigest },
    ]);
    expect(
      (
        await admin.query<{ state: Buffer; binding: Buffer }>(
          'select state_digest state,binding_digest binding from app.connection_oauth2_authorizations where connection_id=$1',
          [connection.connectionId],
        )
      ).rows,
    ).toEqual([{ state: stateDigest, binding: bindingDigest }]);
    const replacement = Buffer.alloc(32, 255);
    await db
      .update(connectionOAuth2Authorizations)
      .set({ stateDigest: replacement })
      .where(
        eq(
          connectionOAuth2Authorizations.connectionId,
          connection.connectionId,
        ),
      );
    expect(await readBytes()).toEqual([
      { state: replacement, binding: bindingDigest },
    ]);
  });
});
