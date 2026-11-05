import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { seedWorkflow, withUpgradeDatabase } from './upgrade-fixture.js';

it('preserves populated connections, destinations, schedules, endpoints and trigger configuration when admission moves to core', async () => {
  await withUpgradeDatabase(107, async ({ admin, upgrade }) => {
    const { workspaceId, workflowId, ownerId } = await seedWorkflow(admin);
    const versionId = randomUUID(),
      scheduleId = randomUUID(),
      webhookId = randomUUID(),
      connectionId = randomUUID(),
      secretId = randomUUID(),
      endpointId = randomUUID(),
      webhookSecretId = randomUUID(),
      destinationId = randomUUID();
    await admin.query(
      'insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by) values($1,$2,$3,1,\'{"settings":{},"nodes":[],"edges":[]}\',$4,\'{}\',$5)',
      [
        versionId,
        workspaceId,
        workflowId,
        `wf:sha256:${'a'.repeat(64)}`,
        ownerId,
      ],
    );
    await admin.query(
      "insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,node_id,kind,status,health_status,desired_config,config_fingerprint) values($1,$3,$4,$5,'schedule','schedule','active','healthy','{}',$6),($2,$3,$4,$5,'webhook','webhook','active','healthy','{}',$6)",
      [
        scheduleId,
        webhookId,
        workspaceId,
        workflowId,
        versionId,
        `trigger:sha256:${'a'.repeat(64)}`,
      ],
    );
    await admin.query(
      "insert into app.trigger_schedules(trigger_id,workspace_id,recurrence_kind,interval_minutes,misfire_policy,config_fingerprint,anchor_at,next_fire_at) values($1,$2,'interval',15,'skip',$3,clock_timestamp(),clock_timestamp()+interval '15 minutes')",
      [scheduleId, workspaceId, `trigger:sha256:${'a'.repeat(64)}`],
    );
    await admin.query(
      "insert into app.webhook_trigger_secret_versions(id,workspace_id,trigger_id,workflow_id,node_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by) values($1,$2,$3,$4,'webhook','kms','key','cipher','nonce','tag',$5)",
      [webhookSecretId, workspaceId, webhookId, workflowId, ownerId],
    );
    await admin.query(
      "insert into app.webhook_trigger_endpoints(id,workspace_id,workflow_id,node_id,endpoint_key_hash,current_secret_version_id) values($1,$2,$3,'webhook',$4,$5)",
      [endpointId, workspaceId, workflowId, 'b'.repeat(64), webhookSecretId],
    );
    await admin.query(
      `with connection as (
      insert into app.connections(id,workspace_id,provider_key,name,auth_type,status,current_secret_version_id,created_by)
      values($1,$2,'resend','Retained connection','resend_api_key','active',$3,$4) returning id
    ) insert into app.connection_secret_versions(id,workspace_id,connection_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
      select $3,$2,id,'kms','key','cipher','AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAA',$4 from connection`,
      [connectionId, workspaceId, secretId, ownerId],
    );
    await admin.query(
      `with destination as (
      insert into app.failure_notification_destinations(id,workspace_id,kind,created_by) values($1,$2,'email',$3) returning id
    ) insert into app.failure_notification_destination_versions(workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
      select $2,id,1,'email','idempotent_with_key',$4::jsonb,$3 from destination`,
      [
        destinationId,
        workspaceId,
        ownerId,
        JSON.stringify({ connectionId, toEmail: 'owner@example.test' }),
      ],
    );
    const tables = [
      'connections',
      'failure_notification_destinations',
      'trigger_schedules',
      'webhook_trigger_endpoints',
      'workflow_triggers',
    ] as const;
    const read = async () => {
      const rows = [];
      for (const table of tables)
        rows.push(
          (
            await admin.query<{ snapshot: unknown }>(
              `select row_to_json(retained) snapshot from app.${table} retained where workspace_id=$1 order by row_to_json(retained)::text`,
              [workspaceId],
            )
          ).rows,
        );
      return rows;
    };
    const before = await read();
    expect(before.map((rows) => rows.length)).toEqual([1, 1, 1, 1, 2]);
    expect(await upgrade(108)).toEqual([
      '0108_integration_admission_in_core.sql',
    ]);
    expect(await read()).toEqual(before);
  });
});
