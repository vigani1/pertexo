import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  seedWorkflow,
  withUpgradeDatabase,
} from '../../platform/migrations/upgrade-fixture.js';

it('preserves a populated ingress window on upgrade and fences atomic increments by credential and observed state', async () => {
  await withUpgradeDatabase(93, async ({ admin, upgrade }) => {
    const { ownerId, workspaceId, workflowId } = await seedWorkflow(admin);
    const version = randomUUID(),
      trigger = randomUUID(),
      secret = randomUUID(),
      endpoint = randomUUID();
    const key = 'a'.repeat(64);
    await admin.query(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
      values($1,$2,$3,1,'{"settings":{},"nodes":[],"edges":[]}',$4,'{}',$5)`,
      [
        version,
        workspaceId,
        workflowId,
        `wf:sha256:${'b'.repeat(64)}`,
        ownerId,
      ],
    );
    await admin.query(
      `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,node_id,kind,status,desired_config,config_fingerprint)
      values($1,$2,$3,$4,'hook','webhook','active','{}',$5)`,
      [
        trigger,
        workspaceId,
        workflowId,
        version,
        `trigger:sha256:${'c'.repeat(64)}`,
      ],
    );
    await admin.query(
      `insert into app.webhook_trigger_secret_versions(id,workspace_id,trigger_id,workflow_id,node_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
      values($1,$2,$3,$4,'hook','kms','key','cipher','nonce','tag',$5)`,
      [secret, workspaceId, trigger, workflowId, ownerId],
    );
    await admin.query(
      `insert into app.webhook_trigger_endpoints(id,workspace_id,workflow_id,node_id,endpoint_key_hash,status,current_secret_version_id)
      values($1,$2,$3,'hook',$4,'active',$5)`,
      [endpoint, workspaceId, workflowId, key, secret],
    );
    await admin.query(
      `insert into app.webhook_endpoint_ingress_limits(endpoint_id,workspace_id,bucket_started_at,request_count)
      values($1,$2,clock_timestamp()-interval '10 seconds',2)`,
      [endpoint, workspaceId],
    );
    const state = async () =>
      (
        await admin.query<{ state: unknown }>(
          'select to_jsonb(counter) state from app.webhook_endpoint_ingress_limits counter where endpoint_id=$1',
          [endpoint],
        )
      ).rows[0];
    const before = await state();
    await upgrade();
    expect(await state()).toEqual(before);
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_app');
      const observed = (
        await client.query<{
          bucket_started_at: string;
          request_count: number;
        }>('select * from app.lock_webhook_ingress_counter($1)', [key])
      ).rows[0];
      if (observed === undefined) throw new Error('Locked counter is missing');
      const write = async (credential: string, expectedCount: number) =>
        (
          await client.query<{ stored: boolean }>(
            'select app.store_webhook_ingress_counter($1,$2,$3,false,$2) stored',
            [credential, observed.bucket_started_at, expectedCount],
          )
        ).rows[0];
      expect(await write('d'.repeat(64), 2)).toEqual({ stored: false });
      expect(await write(key, 1)).toEqual({ stored: false });
      expect(await write(key, 2)).toEqual({ stored: true });
      expect(await write(key, 2)).toEqual({ stored: false });
      await client.query('commit');
    } finally {
      await client.query('rollback');
      client.release();
    }
    expect(
      (
        await admin.query(
          'select request_count from app.webhook_endpoint_ingress_limits where endpoint_id=$1',
          [endpoint],
        )
      ).rows,
    ).toEqual([{ request_count: 3 }]);
    expect(
      (
        await admin.query(
          "select to_regprocedure('app.consume_webhook_ingress_limit(character,integer)') obsolete",
        )
      ).rows,
    ).toEqual([{ obsolete: null }]);
  });
}, 60_000);
