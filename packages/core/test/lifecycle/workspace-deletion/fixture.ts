import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import { changeWorkspaceLifecycle } from '../../../src/lifecycle/deletion/change.js';
import type { WorkspaceLifecycleChange } from '../../../src/lifecycle/deletion/contract.js';
import {
  migrateDatabase,
  dropDisconnectedDatabase,
} from '@pertexo/database/testing';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

const apiBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

const databaseName = `pertexo_test_workspace_deletion_${randomUUID().replaceAll('-', '')}`;

const withDatabase = (baseUrl: string) => {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

const migrationUrl = withDatabase(migrationBaseUrl);

const apiUrl = withDatabase(apiBaseUrl);

const ownerUrl = withDatabase(adminUrl);

export const workspaceId = randomUUID();

export const ownerUserId = randomUUID();

export const otherUserId = randomUUID();

export const connectionId = randomUUID();

const connectionSecretId = randomUUID();

export const queuedRunId = randomUUID();

export const runningRunId = randomUUID();

export const scheduleTriggerId = randomUUID();

const webhookTriggerId = randomUUID();

export const workflowId = randomUUID();

const workflowVersionId = randomUUID();

let api: Pool | undefined;

async function apiWorkspaceQuery(
  text: string,
  values: readonly unknown[],
  actorUserId = ownerUserId,
) {
  if (api === undefined) throw new Error('API pool unavailable');
  const client = await api.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    await client.query("select set_config('app.actor_id',$1,true)", [
      actorUserId,
    ]);
    const result = await client.query(text, [...values]);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Runs a change as the API does: in the actor's workspace transaction. */
export function change(
  input: Partial<WorkspaceLifecycleChange> &
    Pick<WorkspaceLifecycleChange, 'commandType'>,
) {
  if (api === undefined) throw new Error('API pool unavailable');
  const actorUserId = input.actorUserId ?? ownerUserId;
  return changeWorkspaceLifecycle(api, {
    operationId: randomUUID(),
    workspaceId,
    actorUserId,
    reason: 'Closing the workspace',
    idempotencyKeyHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
    requestHash: '1'.repeat(64),
    ...input,
  });
}

export async function asOwner(text: string, values: readonly unknown[] = []) {
  const owner = new Pool({ connectionString: ownerUrl, max: 1 });
  try {
    return await owner.query(text, [...values]);
  } finally {
    await owner.end();
  }
}

export async function beforeAllFixture1() {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,
       pertexo_app,pertexo_maintenance`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase({
    appRole: 'pertexo_app',
    connectionString: migrationUrl,
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
  });
  const owner = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await owner.query('begin');
    await owner.query('set local role pertexo_owner');
    await owner.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    await owner.query(
      `insert into app.users(id,email,display_name) values
       ($1,$2,'Owner'),($3,$4,'Other')`,
      [
        ownerUserId,
        `${ownerUserId}@example.test`,
        otherUserId,
        `${otherUserId}@example.test`,
      ],
    );
    await owner.query(
      "insert into app.workspaces(id,name,slug,created_by) values($1,'Intent fixture',$2,$3)",
      [workspaceId, `intent-${workspaceId}`, ownerUserId],
    );
    await owner.query(
      "insert into app.workspace_memberships(workspace_id,user_id,role) values($1,$2,'owner')",
      [workspaceId, ownerUserId],
    );
    await owner.query(
      `insert into app.auth_sessions(id,user_id,token,expires_at)
       values($1,$2,$3,clock_timestamp()+interval '1 day')`,
      [randomUUID(), ownerUserId, randomUUID()],
    );
    await owner.query(
      `insert into app.workflows(id,workspace_id,name,lifecycle_status,
         activation_status,published_version_id,created_by)
       values($1,$2,'Lifecycle fixture','active','inactive',null,$3)`,
      [workflowId, workspaceId, ownerUserId],
    );
    await owner.query(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,
         version_number,graph_json,checksum,
         executable_json,
         published_by)
       values($1,$2,$3,1,$4::jsonb,$5,'{}'::jsonb,$6)`,
      [
        workflowVersionId,
        workspaceId,
        workflowId,
        JSON.stringify({
          settings: {},
          nodes: [],
          edges: [],
        }),
        `wf:sha256:${'a'.repeat(64)}`,
        ownerUserId,
      ],
    );
    await owner.query(
      "update app.workflows set published_version_id=$2,activation_status='active' where id=$1",
      [workflowId, workflowVersionId],
    );
    await owner.query(
      `insert into app.workflow_triggers(id,workspace_id,workflow_id,
         workflow_version_id,node_id,kind,status,health_status,desired_config,
         config_fingerprint)
       values($1,$2,$3,$4,'schedule','schedule','active','healthy',$5::jsonb,$6),
             ($7,$2,$3,$4,'webhook','webhook','active','healthy','{}'::jsonb,$8)`,
      [
        scheduleTriggerId,
        workspaceId,
        workflowId,
        workflowVersionId,
        JSON.stringify({ recurrence: 'interval' }),
        `trigger:sha256:${'b'.repeat(64)}`,
        webhookTriggerId,
        `trigger:sha256:${'c'.repeat(64)}`,
      ],
    );
    await owner.query(
      `insert into app.trigger_schedules(trigger_id,workspace_id,recurrence_kind,
         interval_minutes,misfire_policy,config_fingerprint,anchor_at,next_fire_at,
         status,health_status,lease_owner,lease_token,lease_acquired_at,lease_expires_at)
       values($1,$2,'interval',5,'skip',$3,clock_timestamp(),
         clock_timestamp()+interval '5 minutes','enabled','healthy','scanner',$4,
         clock_timestamp(),clock_timestamp()+interval '1 minute')`,
      [
        scheduleTriggerId,
        workspaceId,
        `trigger:sha256:${'b'.repeat(64)}`,
        randomUUID(),
      ],
    );
    await owner.query(
      `with connection as (
         insert into app.connections(id,workspace_id,provider_key,name,auth_type,
           status,current_secret_version_id,created_by)
         values($1,$2,'http','Lifecycle connection','http_headers','active',$3,$4)
         returning id
       ) insert into app.connection_secret_versions(id,workspace_id,connection_id,
         kms_key_reference,encrypted_data_key,ciphertext,nonce,
         auth_tag,created_by)
       select $3,$2,id,'kms','key','cipher','AAAAAAAAAAAAAAAA',
         'AAAAAAAAAAAAAAAAAAAAAA',$4  from connection`,
      [connectionId, workspaceId, connectionSecretId, ownerUserId],
    );
    await owner.query('commit');
  } catch (error: unknown) {
    await owner.query('rollback');
    throw error;
  } finally {
    await owner.end();
  }
  api = new Pool({ connectionString: apiUrl, max: 2 });
  const queuedCheckpoint = {
    workflowVersionId,
    revision: 0,
    runStatus: 'queued',
    nextEventSequence: 2,
    readySet: [],
    admittedInvocationKeys: [],
    invocations: [],
    joins: [],
    loops: [],
    remainingIterationBudget: 0,
    cancelRequested: false,
    deadlineExpired: false,
    branchSelections: [],
  };
  const runningCheckpoint = {
    ...queuedCheckpoint,
    revision: 1,
    runStatus: 'running',
    nextEventSequence: 3,
  };
  await apiWorkspaceQuery(
    `insert into app.workflow_runs(id,workspace_id,workflow_id,
       workflow_version_id,trigger_type,status,started_at)
     values($1,$3,$4,$5,'api','queued',null),
           ($2,$3,$4,$5,'api','running',clock_timestamp())`,
    [queuedRunId, runningRunId, workspaceId, workflowId, workflowVersionId],
  );
  await apiWorkspaceQuery(
    `insert into app.run_events(workspace_id,workflow_run_id,sequence,type,payload)
     values($1,$2,1,'run.queued','{}'::jsonb),
           ($1,$3,1,'run.queued','{}'::jsonb),
           ($1,$3,2,'run.started','{}'::jsonb)`,
    [workspaceId, queuedRunId, runningRunId],
  );
  await apiWorkspaceQuery(
    `insert into app.run_checkpoints(workflow_run_id,workspace_id,revision,scheduler_state,workflow_version_id)
     values($1,$3,0,$4::jsonb,$6),
           ($2,$3,1,$5::jsonb,$6)`,
    [
      queuedRunId,
      runningRunId,
      workspaceId,
      JSON.stringify(queuedCheckpoint),
      JSON.stringify(runningCheckpoint),
      workflowVersionId,
    ],
  );
}

export async function afterAllFixture2() {
  await api?.end();
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
}
