import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  seedWorkflow,
  withUpgradeDatabase,
} from '../platform/migrations/upgrade-fixture.js';

it('keeps credential-to-scope discovery narrow while returning standing for core to decide after a populated upgrade', async () => {
  await withUpgradeDatabase(94, async ({ admin, upgrade }) => {
    const { workspaceId, workflowId } = await seedWorkflow(admin);
    const publicId = randomUUID();
    const digest = 'a'.repeat(64);
    await admin.query(
      `insert into app.workflow_forms(workspace_id,workflow_id,node_id,access,public_id,capability_hash)
      values($1,$2,'form','public',$3,$4)`,
      [workspaceId, workflowId, publicId, digest],
    );
    await admin.query(
      "update app.workspaces set status='suspended' where id=$1",
      [workspaceId],
    );
    const state = async () =>
      (
        await admin.query<{ state: unknown }>(
          'select to_jsonb(form) state from app.workflow_forms form where workflow_id=$1',
          [workflowId],
        )
      ).rows;
    const before = await state();
    await upgrade();
    expect(await state()).toEqual(
      before.map(({ state }) => ({
        state: {
          ...(state as Record<string, unknown>),
          sealed_capability: null,
        },
      })),
    );
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_app');
      const lookup = async (capability: string) =>
        (
          await client.query<Record<string, unknown>>(
            'select * from app.lookup_public_form($1,$2)',
            [publicId, capability],
          )
        ).rows;
      expect(await lookup('b'.repeat(64))).toEqual([]);
      expect(await lookup(digest)).toEqual([
        {
          workspace_id: workspaceId,
          workflow_id: workflowId,
          node_id: 'form',
          access: 'public',
          workspace_status: 'suspended',
        },
      ]);
      await client.query('commit');
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
}, 60_000);
