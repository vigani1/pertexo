import { createHash } from 'node:crypto';
import { lockManualFixtureClient } from '../attempts/manual-start.js';

import type { PoolClient } from 'pg';

import type { LifecycleIds } from './contract.js';

export async function seedWorkflowRows(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  ids: LifecycleIds,
): Promise<void> {
  const graph = {
    settings: { proof: 'workflow-lifecycle' },
    nodes: [],
    edges: [],
  };
  const executable = {
    nodes: [],
    edges: [],
  };
  const workflowFingerprint = `wf:sha256:${'c'.repeat(64)}`;
  const activeWebhookFingerprint = `trigger:sha256:${'1'.repeat(64)}`;
  const activeScheduleFingerprint = `trigger:sha256:${'2'.repeat(64)}`;
  const disabledWebhookFingerprint = `trigger:sha256:${'3'.repeat(64)}`;
  const disabledScheduleFingerprint = `trigger:sha256:${'4'.repeat(64)}`;
  const activeScheduleConfig = {
    kind: 'interval',
    intervalMinutes: 60,
    misfirePolicy: 'catch_up_once',
  };
  const disabledScheduleConfig = {
    kind: 'interval',
    intervalMinutes: 120,
    misfirePolicy: 'skip',
  };

  await client.query(
    `insert into app.workflows
       (id,workspace_id,name,lifecycle_status,activation_status,lifecycle_revision,
        published_version_id,created_by)
     values ($1,$2,'Worker lifecycle proof','active','active',1,null,$3)`,
    [ids.workflow, workspaceId, actorId],
  );
  await client.query(
    `insert into app.workflow_drafts
       (workflow_id,workspace_id,revision,graph_json,updated_by)
     values ($1,$2,17,$3::jsonb,$4)`,
    [ids.workflow, workspaceId, JSON.stringify(graph), actorId],
  );
  await client.query(
    `insert into app.workflow_versions
       (id,workspace_id,workflow_id,version_number,graph_json,
        checksum,published_by,executable_json)
     values ($1,$2,$3,3,$4::jsonb,$5,$6,$7::jsonb)`,
    [
      ids.version,
      workspaceId,
      ids.workflow,
      JSON.stringify(graph),
      workflowFingerprint,
      actorId,
      JSON.stringify(executable),
    ],
  );
  await client.query(
    `update app.workflows set published_version_id=$2 where id=$1`,
    [ids.workflow, ids.version],
  );

  await client.query(
    `insert into app.workflow_triggers
       (id,workspace_id,workflow_id,workflow_version_id,node_id,kind,status,
        desired_config,config_fingerprint,health_status)
     values
       ($1,$2,$3,$4,'active-webhook','webhook','active','{}'::jsonb,$5,'healthy'),
       ($6,$2,$3,$4,'active-schedule','schedule','active',$7::jsonb,$8,'healthy'),
       ($9,$2,$3,$4,'disabled-webhook','webhook','disabled','{}'::jsonb,$10,'disabled'),
       ($11,$2,$3,$4,'disabled-schedule','schedule','disabled',$12::jsonb,$13,'disabled')`,
    [
      ids.activeWebhook,
      workspaceId,
      ids.workflow,
      ids.version,
      activeWebhookFingerprint,
      ids.activeSchedule,
      JSON.stringify(activeScheduleConfig),
      activeScheduleFingerprint,
      ids.disabledWebhook,
      disabledWebhookFingerprint,
      ids.disabledSchedule,
      JSON.stringify(disabledScheduleConfig),
      disabledScheduleFingerprint,
    ],
  );
  await client.query(
    `insert into app.trigger_schedules
       (trigger_id,workspace_id,recurrence_kind,interval_minutes,misfire_policy,
        config_fingerprint,anchor_at,next_fire_at,status,health_status)
     values
       ($1,$2,'interval',60,'catch_up_once',$3,clock_timestamp()+interval '1 hour',
        clock_timestamp()+interval '2 hours','enabled','healthy'),
       ($4,$2,'interval',120,'skip',$5,clock_timestamp()+interval '1 hour',
        clock_timestamp()+interval '3 hours','disabled','disabled')`,
    [
      ids.activeSchedule,
      workspaceId,
      activeScheduleFingerprint,
      ids.disabledSchedule,
      disabledScheduleFingerprint,
    ],
  );
}

export async function seedApiOwnedRows(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  ids: LifecycleIds,
): Promise<void> {
  for (const [secretId, triggerId] of [
    [ids.activeWebhookSecret, ids.activeWebhook] as const,
    [ids.disabledWebhookSecret, ids.disabledWebhook] as const,
  ]) {
    await client.query(
      `insert into app.webhook_trigger_secret_versions
         (id,workspace_id,trigger_id,workflow_id,node_id,kms_key_reference,
          encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
       select $1,workspace_id,id,workflow_id,node_id,'worker-lifecycle-kms','worker-lifecycle-key',
               'worker-lifecycle-cipher','worker-lifecycle-nonce',
               'worker-lifecycle-auth-tag',$4
         from app.workflow_triggers where workspace_id=$2 and id=$3`,
      [secretId, workspaceId, triggerId, actorId],
    );
  }
  await client.query(
    `insert into app.webhook_trigger_endpoints
       (id,workspace_id,workflow_id,node_id,endpoint_key_hash,status,current_secret_version_id)
     values
       ($1,$2,$3,'active-webhook',$4,'active',$5),
       ($6,$2,$3,'disabled-webhook',$7,'disabled',$8)`,
    [
      ids.activeWebhookEndpoint,
      workspaceId,
      ids.workflow,
      'a'.repeat(64),
      ids.activeWebhookSecret,
      ids.disabledWebhookEndpoint,
      'b'.repeat(64),
      ids.disabledWebhookSecret,
    ],
  );
  await lockManualFixtureClient(
    client,
    workspaceId,
    ids.workflow,
    createHash('sha256').update(ids.runs.queued).digest('hex'),
  );
  await client.query(
    `insert into app.workflow_runs
       (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
        started_at,completed_at,output_ref)
     values
       ($1,$2,$3,$4,'manual','queued',NULL,NULL,NULL),
       ($5,$2,$3,$4,'manual','running',
        clock_timestamp()-interval '8 minutes',NULL,NULL),
       ($6,$2,$3,$4,'manual','waiting',
        clock_timestamp()-interval '7 minutes',NULL,NULL),
       ($7,$2,$3,$4,'manual','succeeded',
        clock_timestamp()-interval '10 minutes',
        clock_timestamp()-interval '9 minutes',
        '{"prior":true,"preserved":"lifecycle","status":"succeeded"}'::jsonb)`,
    [
      ids.runs.queued,
      workspaceId,
      ids.workflow,
      ids.version,
      ids.runs.running,
      ids.runs.waiting,
      ids.runs.succeeded,
    ],
  );
  await client.query(
    `insert into app.run_events
       (workspace_id,workflow_run_id,sequence,type,payload)
     values
       ($1,$2,1,'run.queued','{"runStatus":"queued","proof":"lifecycle"}'::jsonb),
       ($1,$3,1,'run.queued','{"runStatus":"running","proof":"lifecycle"}'::jsonb),
       ($1,$3,2,'run.started','{"runStatus":"running","proof":"lifecycle"}'::jsonb),
       ($1,$4,1,'run.queued','{"runStatus":"waiting","proof":"lifecycle"}'::jsonb),
       ($1,$4,2,'run.started','{"runStatus":"waiting","proof":"lifecycle"}'::jsonb),
       ($1,$4,3,'run.waiting','{"runStatus":"waiting","proof":"lifecycle"}'::jsonb),
       ($1,$5,1,'run.queued','{"runStatus":"succeeded","proof":"lifecycle"}'::jsonb),
       ($1,$5,2,'run.started','{"runStatus":"succeeded","proof":"lifecycle"}'::jsonb),
       ($1,$5,3,'run.succeeded','{"runStatus":"succeeded","proof":"lifecycle"}'::jsonb)`,
    [
      workspaceId,
      ids.runs.queued,
      ids.runs.running,
      ids.runs.waiting,
      ids.runs.succeeded,
    ],
  );
  await client.query(
    `insert into app.run_checkpoints
       (workflow_run_id,workspace_id,revision,scheduler_state,
        resume_at,workflow_version_id)
     values
       ($1,$2,1,
        '{"runStatus":"queued","nextEventSequence":2,"proof":"lifecycle"}'::jsonb,
        NULL,$6),
       ($3,$2,2,
        '{"runStatus":"running","nextEventSequence":3,"proof":"lifecycle"}'::jsonb,
        NULL,$6),
       ($4,$2,3,
        '{"runStatus":"waiting","nextEventSequence":4,"proof":"lifecycle"}'::jsonb,
        clock_timestamp()+interval '1 hour',$6),
       ($5,$2,4,
        '{"runStatus":"succeeded","nextEventSequence":4,"proof":"lifecycle"}'::jsonb,
        NULL,$6)`,
    [
      ids.runs.queued,
      workspaceId,
      ids.runs.running,
      ids.runs.waiting,
      ids.runs.succeeded,
      ids.version,
    ],
  );
}
