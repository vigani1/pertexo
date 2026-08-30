import { createHash, randomUUID } from 'node:crypto';
import { count, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  acceptWorkflowRun,
  WorkspaceRunAdmissionDeniedError,
} from '../src/execution-acceptance.js';
import { workflowRuns } from '../src/schema.js';
import {
  acceptanceInput,
  apiDatabase,
  apiUrl,
  createNotificationFixture,
  expectAcceptanceRecordCounts,
  hasPostgresCode,
  insertDirectPinnedRun,
  installExecutionAcceptanceFixture,
  migrationUrl,
  setFixtureStatus,
  setNotificationPolicy,
  waitForDatabaseLock,
  workspaceA,
  workspaceCreatorId,
  workflowId,
} from './execution-acceptance.fixtures.js';

installExecutionAcceptanceFixture();

describe('workflow run notification pinning', () => {
  it('rejects malformed destination pins and inactive acceptance identities atomically', async () => {
    const valid = await createNotificationFixture();
    const unrelated = await createNotificationFixture();
    const wrongProvider = await createNotificationFixture({
      connectionKind: 'slack',
      destinationKind: 'email',
    });
    const validPin = {
      destinationId: valid.destinationId,
      secretVersionId: valid.secretVersionId,
      sideEffectClass: 'idempotent_with_key' as const,
    };
    const expectRejected = async (
      operation: () => Promise<void>,
    ): Promise<void> => {
      await expect(operation()).rejects.toSatisfy(hasPostgresCode('23514'));
      await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
        expect(await db.select({ count: count() }).from(workflowRuns)).toEqual([
          { count: 0 },
        ]);
      });
    };

    await expectRejected(() =>
      insertDirectPinnedRun({ ...validPin, sideEffectClass: 'unsafe' }),
    );
    await expectRejected(() =>
      insertDirectPinnedRun({
        ...validPin,
        secretVersionId: unrelated.secretVersionId,
      }),
    );
    await expectRejected(() =>
      insertDirectPinnedRun({
        ...validPin,
        destinationId: wrongProvider.destinationId,
        secretVersionId: wrongProvider.secretVersionId,
      }),
    );

    for (const [table, id, status] of [
      ['failure_notification_destinations', valid.destinationId, 'disabled'],
      ['connections', valid.connectionId, 'revoked'],
    ] as const) {
      await setFixtureStatus(table, id, status);
      await expectRejected(() => insertDirectPinnedRun(validPin));
      await setFixtureStatus(
        table,
        id,
        table === 'failure_notification_destinations' ? 'enabled' : 'active',
      );
    }
    await setFixtureStatus('workspaces', workspaceA, 'suspended');
    await expect(insertDirectPinnedRun(validPin)).rejects.toSatisfy(
      hasPostgresCode('PTA01'),
    );
    await setFixtureStatus('workspaces', workspaceA, 'active');

    await expect(
      apiDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(sql`
          insert into app.failure_notification_destination_versions
            (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
          values (${workspaceA},${randomUUID()},1,'email','idempotent_with_key',
            ${JSON.stringify({ connectionId: 'malformed', toEmail: 'pin@example.test' })}::jsonb,
            ${workspaceCreatorId})
        `),
      ),
    ).rejects.toSatisfy(hasPostgresCode('23514'));
  });

  it('serializes destination disable before acceptance and persists no stale pin', async () => {
    const fixture = await createNotificationFixture();
    await setNotificationPolicy(fixture.destinationId);
    const pool = new Pool({ connectionString: apiUrl, max: 1 });
    const disabling = await pool.connect();
    const disablingProcessId = await disabling
      .query<{ process_id: number }>('select pg_backend_pid() process_id')
      .then(({ rows }) => rows[0]?.process_id);
    if (disablingProcessId === undefined)
      throw new Error('Expected destination-disabling database process');
    try {
      await disabling.query('begin');
      await disabling.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await disabling.query(
        `update app.failure_notification_destinations set status='disabled'
          where workspace_id=$1 and id=$2`,
        [workspaceA, fixture.destinationId],
      );
      const acceptance = apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      );
      await waitForDatabaseLock(disablingProcessId);
      await disabling.query('commit');
      const accepted = await acceptance;
      const pin = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute<{ destination_id: string | null }>(sql`
          select failure_notification_destination_id destination_id
            from app.workflow_runs where id=${accepted.runId}
        `),
      );
      expect(pin.rows[0]).toEqual({ destination_id: null });
    } finally {
      await disabling.query('rollback').catch(() => undefined);
      disabling.release();
      await pool.end();
    }
  });

  it('serializes credential rotation before acceptance and pins the new current secret', async () => {
    const fixture = await createNotificationFixture();
    await setNotificationPolicy(fixture.destinationId);
    const nextSecretVersionId = randomUUID();
    const pool = new Pool({ connectionString: apiUrl, max: 1 });
    const rotating = await pool.connect();
    const rotatingProcessId = await rotating
      .query<{ process_id: number }>('select pg_backend_pid() process_id')
      .then(({ rows }) => rows[0]?.process_id);
    if (rotatingProcessId === undefined)
      throw new Error('Expected credential-rotation database process');
    try {
      await rotating.query('begin');
      await rotating.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await rotating.query(
        `insert into app.connection_secret_versions (
           id,workspace_id,connection_id,schema_version,kms_key_reference,
           encrypted_data_key,ciphertext,nonce,auth_tag,created_by
         ) values ($1,$2,$3,1,'kms','new-key','new-cipher','BBBBBBBBBBBBBBBB',
           'BBBBBBBBBBBBBBBBBBBBBB',$4)`,
        [
          nextSecretVersionId,
          workspaceA,
          fixture.connectionId,
          workspaceCreatorId,
        ],
      );
      await rotating.query(
        `update app.connections set current_secret_version_id=$3
          where workspace_id=$1 and id=$2`,
        [workspaceA, fixture.connectionId, nextSecretVersionId],
      );
      const acceptance = apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      );
      await waitForDatabaseLock(rotatingProcessId);
      await rotating.query('commit');
      const accepted = await acceptance;
      const pin = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute<{ secret_version_id: string | null }>(sql`
          select failure_notification_connection_secret_version_id secret_version_id
            from app.workflow_runs where id=${accepted.runId}
        `),
      );
      expect(pin.rows[0]).toEqual({ secret_version_id: nextSecretVersionId });
    } finally {
      await rotating.query('rollback').catch(() => undefined);
      rotating.release();
      await pool.end();
    }
  });

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
           id,workspace_id,connection_id,schema_version,kms_key_reference,
           encrypted_data_key,ciphertext,nonce,auth_tag,created_by
         ) values ($1,$2,$3,1,'kms','key','cipher','AAAAAAAAAAAAAAAA',
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

    const first = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, acceptanceInput()),
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
          id,workspace_id,connection_id,schema_version,kms_key_reference,
          encrypted_data_key,ciphertext,nonce,auth_tag,created_by
        ) values (${nextSecretVersionId},${workspaceA},${connectionId},1,
          'kms','key2','cipher2','BBBBBBBBBBBBBBBB',
          'BBBBBBBBBBBBBBBBBBBBBB',${workspaceCreatorId})
      `);
      await db.execute(sql`
        update app.connections set current_secret_version_id=${nextSecretVersionId}
         where workspace_id=${workspaceA} and id=${connectionId}
      `);
    });

    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      ),
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
        if (status === 'deleted') {
          await client.query(
            `with job as (
               insert into app.workspace_purge_jobs
                 (id,workspace_id,command_id,actor_ref,reason,occurred_at,status,
                  control_sequence,control_record_hash,completed_at)
               values (gen_random_uuid(),$1,gen_random_uuid(),'fixture:purge',
                 'Completed purge fixture',now(),'completed',1,$2,now())
               returning id
             ) insert into app.workspace_purge_steps
                 (job_id,step_name,status,completed_at)
               select id,step_name,'completed',now() from job
               cross join unnest(array['object_versions','tenant_rows']) step_name`,
            [workspaceA, 'f'.repeat(64)],
          );
        }
        await client.query(
          `update app.workspaces
           set status = $2::varchar,
               deletion_requested_at = case when $2::text = 'suspended' then null else now() end,
               deletion_requested_by = case when $2::text = 'suspended' then null::uuid else $3::uuid end,
               deletion_reason = case when $2::text = 'suspended' then null::varchar else 'fixture deletion'::varchar end,
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
});
