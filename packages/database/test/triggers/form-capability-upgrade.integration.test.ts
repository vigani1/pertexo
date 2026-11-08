import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  seedWorkflow,
  withUpgradeDatabase,
} from '../platform/migrations/upgrade-fixture.js';

it('preserves a legacy public link and permits sealed copies only with hashes', async () => {
  await withUpgradeDatabase(114, async ({ admin, upgrade }) => {
    const { workspaceId, workflowId } = await seedWorkflow(admin);
    const publicId = randomUUID();
    const hash = 'a'.repeat(64);
    await admin.query(
      `insert into app.workflow_forms(workspace_id,workflow_id,node_id,access,public_id,capability_hash) values($1,$2,'form','public',$3,$4)`,
      [workspaceId, workflowId, publicId, hash],
    );
    await upgrade();
    const row = await admin.query(
      'select capability_hash,sealed_capability from app.workflow_forms where workflow_id=$1',
      [workflowId],
    );
    expect(row.rows).toEqual([
      { capability_hash: hash, sealed_capability: null },
    ]);
    expect(
      (
        await admin.query('select * from app.lookup_public_form($1,$2)', [
          publicId,
          hash,
        ])
      ).rows,
    ).toHaveLength(1);
    await admin.query(
      `update app.workflow_forms set sealed_capability='{"ciphertext":"sealed"}'::jsonb where workflow_id=$1`,
      [workflowId],
    );
    await expect(
      admin.query(
        `update app.workflow_forms set access='members',capability_hash=null where workflow_id=$1`,
        [workflowId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await admin.query(
      `update app.workflow_forms set access='members',capability_hash=null,sealed_capability=null where workflow_id=$1`,
      [workflowId],
    );
    expect(
      (
        await admin.query('select * from app.lookup_public_form($1,$2)', [
          publicId,
          hash,
        ])
      ).rows,
    ).toEqual([]);
  });
}, 60_000);
