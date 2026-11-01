import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { acceptWorkflowRun } from '../../../../src/runs/commands/acceptance.repository.js';
import { WorkspaceRunAdmissionDeniedError } from '../../../../src/runs/commands/acceptance/errors.js';
import {
  acceptanceInput,
  apiDatabase,
  expectAcceptanceRecordCounts,
  lockManualFixtureStart,
  migrationUrl,
  workspaceA,
  workspaceCreatorId,
  workflowId,
} from '../fixtures.js';

export function registerPinsManualRunDestinationOnce(): void {
  it('pins a manual-run destination once and replays after config, status, and credential changes', async () => {
    const connectionId = randomUUID();
    const secretVersionId = randomUUID();
    const destinationId = randomUUID();
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    const client = await owner.connect();
    const protectedTables = [
      'workflows',
      'connections',
      'connection_secret_versions',
      'failure_notification_destinations',
      'failure_notification_destination_versions',
      'workflow_failure_notification_policies',
    ] as const;
    try {
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
         values ($1,$2,'Manual notification acceptance',$3)`,
        [workflowId, workspaceA, workspaceCreatorId],
      );
      await client.query(
        `insert into app.connections (
           id,workspace_id,provider_key,name,auth_type,status,
           current_secret_version_id,created_by
         ) values ($1,$2,'email','Manual notification email',
           'resend_api_key','active',$3,$4)`,
        [connectionId, workspaceA, secretVersionId, workspaceCreatorId],
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
         values ($1,$2,'email','enabled',1,$3)`,
        [destinationId, workspaceA, workspaceCreatorId],
      );
      await client.query(
        `insert into app.failure_notification_destination_versions
           (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
         values ($1,$2,1,'email','idempotent_with_key',$3::jsonb,$4)`,
        [
          workspaceA,
          destinationId,
          JSON.stringify({ connectionId, toEmail: 'manual@example.test' }),
          workspaceCreatorId,
        ],
      );
      await client.query(
        `insert into app.workflow_failure_notification_policies
           (workspace_id,workflow_id,destination_id,updated_by)
         values ($1,$2,$3,$4)`,
        [workspaceA, workflowId, destinationId, workspaceCreatorId],
      );
      await client.query('set constraints all immediate');
      for (const table of protectedTables)
        await client.query(`alter table app.${table} force row level security`);
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
      await owner.end();
    }

    const first = await apiDatabase.withWorkspace(
      workspaceA,
      async (transaction) => {
        await lockManualFixtureStart(transaction);
        return acceptWorkflowRun(transaction, {
          ...acceptanceInput(),
          triggerType: 'manual',
        });
      },
    );
    const nextSecretVersionId = randomUUID();
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      await db.execute(sql`
        insert into app.failure_notification_destination_versions
          (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
        values (${workspaceA},${destinationId},2,'email','idempotent_with_key',
          ${JSON.stringify({ connectionId, toEmail: 'changed@example.test' })}::jsonb,
          ${workspaceCreatorId})
      `);
      await db.execute(sql`
        update app.failure_notification_destinations
           set current_config_version=2,status='disabled'
         where workspace_id=${workspaceA} and id=${destinationId}
      `);
      await db.execute(sql`
        insert into app.connection_secret_versions (
          id,workspace_id,connection_id,kms_key_reference,
          encrypted_data_key,ciphertext,nonce,auth_tag,created_by
        ) values (${nextSecretVersionId},${workspaceA},${connectionId},
          'kms','key2','cipher2','BBBBBBBBBBBBBBBB',
          'BBBBBBBBBBBBBBBBBBBBBB',${workspaceCreatorId})
      `);
      await db.execute(sql`
        update app.connections set current_secret_version_id=${nextSecretVersionId},health_revision=health_revision+1,
          last_health_transition_at=clock_timestamp(),last_health_transition_source='rotation'
         where workspace_id=${workspaceA} and id=${connectionId}
      `);
    });

    await expect(
      apiDatabase.withWorkspace(workspaceA, async (transaction) => {
        await lockManualFixtureStart(transaction);
        return acceptWorkflowRun(transaction, {
          ...acceptanceInput(),
          triggerType: 'manual',
        });
      }),
    ).resolves.toEqual({ ...first, duplicate: true });
    const pins = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute<{
        destination_config_version: number | null;
        destination_id: string | null;
        secret_version_id: string | null;
      }>(sql`
        select failure_notification_destination_id destination_id,
               failure_notification_destination_config_version destination_config_version,
               failure_notification_connection_secret_version_id secret_version_id
          from app.workflow_runs where id=${first.runId}
      `),
    );
    expect(pins.rows[0]).toEqual({
      destination_id: destinationId,
      destination_config_version: 1,
      secret_version_id: secretVersionId,
    });

    const second = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, {
        ...acceptanceInput(
          createHash('sha256').update('request-2').digest('hex'),
        ),
        keyHash: createHash('sha256').update('acceptance-key-2').digest('hex'),
      }),
    );
    const secondPins = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute<{ destination_id: string | null }>(sql`
        select failure_notification_destination_id destination_id
          from app.workflow_runs where id=${second.runId}
      `),
    );
    expect(secondPins.rows[0]).toEqual({ destination_id: null });
  });

  it.each(['suspended', 'pending_deletion', 'deleted'] as const)(
    'rejects new runs while the workspace is %s without persisting acceptance state',
    async (status) => {
      const owner = new Pool({ connectionString: migrationUrl, max: 1 });
      const client = await owner.connect();
      try {
        await client.query('begin');
        await client.query('set local role pertexo_owner');
        await client.query(
          `update app.workspaces
           set status = $2::varchar,
               name = case when $2::text = 'deleted' then 'Deleted workspace' else name end,
               slug = case when $2::text = 'deleted' then 'deleted-' || id::text else slug end,
               created_by = case when $2::text = 'deleted' then null else created_by end,
               deletion_requested_at = case when $2::text = 'suspended' then null else now() end,
               deletion_requested_by = case when $2::text = 'pending_deletion' then $3::uuid else null::uuid end,
               deletion_reason = case $2::text when 'suspended' then null::varchar
                 when 'deleted' then 'purged'::varchar else 'fixture deletion'::varchar end,
               purge_after = case when $2::text = 'suspended' then null else now() + interval '30 days' end
           where id = $1`,
          [workspaceA, status, workspaceCreatorId],
        );
        await client.query('commit');
      } catch (error: unknown) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
        await owner.end();
      }

      await expect(
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, acceptanceInput()),
        ),
      ).rejects.toBeInstanceOf(WorkspaceRunAdmissionDeniedError);
      await expectAcceptanceRecordCounts(0);
    },
  );
}
