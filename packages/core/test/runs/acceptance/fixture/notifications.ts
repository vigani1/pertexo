import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';

import { generatePersistedId } from '@pertexo/database/platform';

import {
  migrationUrl,
  apiUrl,
  workspaceA,
  workflowId,
  workflowVersionId,
  workspaceCreatorId,
  apiDatabase,
} from './base.js';

export async function createNotificationFixture(
  input: Readonly<{
    connectionKind?: 'email' | 'slack';
    destinationKind?: 'email' | 'slack';
  }> = {},
): Promise<
  Readonly<{
    connectionId: string;
    destinationId: string;
    secretVersionId: string;
  }>
> {
  const connectionKind = input.connectionKind ?? 'email';
  const destinationKind = input.destinationKind ?? 'email';
  const connectionId = generatePersistedId();
  const destinationId = randomUUID();
  const secretVersionId = randomUUID();
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  let client: PoolClient | undefined;
  const protectedTables = [
    'workflows',
    'connections',
    'connection_secret_versions',
    'failure_notification_destinations',
    'failure_notification_destination_versions',
  ] as const;
  try {
    client = await pool.connect();
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceA,
    ]);
    for (const table of protectedTables)
      await client.query(
        `alter table app.${table} no force row level security`,
      );
    await client.query(
      `insert into app.workflows (id,workspace_id,name,created_by)
       values ($1,$2,'Notification pin fixture',$3)
       on conflict (id) do nothing`,
      [workflowId, workspaceA, workspaceCreatorId],
    );
    await client.query(
      `insert into app.connections (
         id,workspace_id,provider_key,name,auth_type,status,
         current_secret_version_id,created_by
       ) values ($1,$2,$3,$7,$4,'active',$5,$6)`,
      [
        connectionId,
        workspaceA,
        connectionKind,
        connectionKind === 'slack' ? 'slack_bot_token' : 'resend_api_key',
        secretVersionId,
        workspaceCreatorId,
        `Notification pin ${connectionId}`,
      ],
    );
    await client.query(
      `insert into app.connection_secret_versions (
         id,workspace_id,connection_id,kms_key_reference,
         encrypted_data_key,ciphertext,nonce,auth_tag,created_by
       ) values ($1,$2,$3,'kms','key','cipher','AAAAAAAAAAAAAAAA',
         'AAAAAAAAAAAAAAAAAAAAAA',$4)`,
      [secretVersionId, workspaceA, connectionId, workspaceCreatorId],
    );
    await client.query(
      `insert into app.failure_notification_destinations
         (id,workspace_id,kind,status,current_config_version,created_by)
       values ($1,$2,$3,'enabled',1,$4)`,
      [destinationId, workspaceA, destinationKind, workspaceCreatorId],
    );
    await client.query(
      `insert into app.failure_notification_destination_versions
         (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
       values ($1,$2,1,$3,$4,$5::jsonb,$6)`,
      [
        workspaceA,
        destinationId,
        destinationKind,
        destinationKind === 'slack' ? 'unsafe' : 'idempotent_with_key',
        JSON.stringify(
          destinationKind === 'slack'
            ? { connectionId, channelId: 'C12345' }
            : { connectionId, toEmail: 'pin@example.test' },
        ),
        workspaceCreatorId,
      ],
    );
    await client.query('set constraints all immediate');
    for (const table of protectedTables)
      await client.query(`alter table app.${table} force row level security`);
    await client.query('commit');
    return { connectionId, destinationId, secretVersionId };
  } catch (error: unknown) {
    await client?.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

export async function insertDirectPinnedRun(
  pin: Readonly<{
    destinationId: string;
    secretVersionId: string;
    sideEffectClass: 'idempotent_with_key' | 'unsafe';
  }>,
): Promise<void> {
  await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
    db
      .execute(
        sql`
      insert into app.workflow_runs (
        id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
        failure_notification_destination_id,
        failure_notification_destination_config_version,
        failure_notification_side_effect_class,
        failure_notification_connection_secret_version_id
      ) values (${randomUUID()},${workspaceA},${workflowId},${workflowVersionId},
        'api','queued',${pin.destinationId},1,${pin.sideEffectClass},
        ${pin.secretVersionId})
    `,
      )
      .then(() => undefined),
  );
}

export async function setFixtureStatus(
  table: 'connections' | 'failure_notification_destinations' | 'workspaces',
  id: string,
  status: string,
): Promise<void> {
  const pool = new Pool({
    connectionString: table === 'workspaces' ? migrationUrl : apiUrl,
    max: 1,
  });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('begin');
    if (table === 'workspaces')
      await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceA,
    ]);
    const updated = await client.query(
      `update app.${table} set status=$2 where id=$1`,
      [id, status],
    );
    if (updated.rowCount !== 1) throw new Error('Fixture status update failed');
    await client.query('commit');
  } catch (error: unknown) {
    await client?.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

export async function setNotificationPolicy(
  destinationId: string,
): Promise<void> {
  const pool = new Pool({ connectionString: apiUrl, max: 1 });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceA,
    ]);
    await client.query(
      `insert into app.workflow_failure_notification_policies
         (workspace_id,workflow_id,destination_id,updated_by)
       values ($1,$2,$3,$4)`,
      [workspaceA, workflowId, destinationId, workspaceCreatorId],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client?.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}
