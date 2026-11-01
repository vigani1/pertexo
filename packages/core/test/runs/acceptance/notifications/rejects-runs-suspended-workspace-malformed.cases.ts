import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { acceptWorkflowRun } from '../../../../src/runs/commands/acceptance.repository.js';
import {
  acceptanceInput,
  apiDatabase,
  apiUrl,
  createNotificationFixture,
  hasPostgresCode,
  insertDirectPinnedRun,
  setFixtureStatus,
  setNotificationPolicy,
  waitForDatabaseLock,
  workspaceA,
  workspaceCreatorId,
  workflowId,
  workflowVersionId,
} from '../fixtures.js';
import { hasPostgresConstraint } from './fixture.js';

export function registerRejectsRunsSuspendedWorkspaceMalformed(): void {
  it('rejects runs in a suspended workspace and malformed pins by constraint', async () => {
    const valid = await createNotificationFixture();
    const validPin = {
      destinationId: valid.destinationId,
      secretVersionId: valid.secretVersionId,
      sideEffectClass: 'idempotent_with_key' as const,
    };
    await setFixtureStatus('workspaces', workspaceA, 'suspended');
    await expect(insertDirectPinnedRun(validPin)).rejects.toSatisfy(
      hasPostgresCode('PTA01'),
    );
    await setFixtureStatus('workspaces', workspaceA, 'active');

    for (const config of [
      { connectionId: 'malformed', toEmail: 'pin@example.test' },
      { connectionId: null, toEmail: 'pin@example.test' },
      { connectionId: 7, toEmail: 'pin@example.test' },
      { connectionId: valid.connectionId, toEmail: null },
      {
        connectionId: valid.connectionId,
        toEmail: { value: 'pin@example.test' },
      },
    ])
      await expect(
        apiDatabase.withWorkspace(workspaceA, ({ db }) =>
          db.execute(sql`
            insert into app.failure_notification_destination_versions
              (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
            values (${workspaceA},${randomUUID()},1,'email','idempotent_with_key',
              ${JSON.stringify(config)}::jsonb,${workspaceCreatorId})
          `),
        ),
      ).rejects.toSatisfy(
        hasPostgresConstraint(
          'failure_notification_destination_versions_config_strict',
        ),
      );

    await expect(
      apiDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(sql`
          insert into app.workflow_runs (
            id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
            failure_notification_destination_id
          ) values (
            ${randomUUID()},${workspaceA},${workflowId},${workflowVersionId},
            'api','queued',${valid.destinationId}
          )
        `),
      ),
    ).rejects.toSatisfy(
      hasPostgresConstraint(
        'workflow_runs_failure_notification_policy_complete',
      ),
    );
  });

  it('serializes destination disable before acceptance and persists no stale pin', async () => {
    const fixture = await createNotificationFixture();
    await setNotificationPolicy(fixture.destinationId);
    const pool = new Pool({ connectionString: apiUrl, max: 1 });
    const disabling = await pool.connect();
    let acceptance: ReturnType<typeof acceptWorkflowRun> | undefined;
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
      acceptance = apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      );
      const observedAcceptance = acceptance.then(
        () => undefined,
        (error: unknown) => error,
      );
      await waitForDatabaseLock(disablingProcessId);
      await disabling.query('commit');
      const earlyFailure = await observedAcceptance;
      if (earlyFailure instanceof Error) throw earlyFailure;
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
      if (acceptance !== undefined) await Promise.allSettled([acceptance]);
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
    let acceptance: ReturnType<typeof acceptWorkflowRun> | undefined;
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
           id,workspace_id,connection_id,kms_key_reference,
           encrypted_data_key,ciphertext,nonce,auth_tag,created_by
         ) values ($1,$2,$3,'kms','new-key','new-cipher','BBBBBBBBBBBBBBBB',
           'BBBBBBBBBBBBBBBBBBBBBB',$4)`,
        [
          nextSecretVersionId,
          workspaceA,
          fixture.connectionId,
          workspaceCreatorId,
        ],
      );
      await rotating.query(
        `update app.connections set current_secret_version_id=$3,health_revision=health_revision+1,
           last_health_transition_at=clock_timestamp(),last_health_transition_source='rotation'
          where workspace_id=$1 and id=$2`,
        [workspaceA, fixture.connectionId, nextSecretVersionId],
      );
      acceptance = apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      );
      const observedAcceptance = acceptance.then(
        () => undefined,
        (error: unknown) => error,
      );
      await waitForDatabaseLock(rotatingProcessId);
      await rotating.query('commit');
      const earlyFailure = await observedAcceptance;
      if (earlyFailure instanceof Error) throw earlyFailure;
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
      if (acceptance !== undefined) await Promise.allSettled([acceptance]);
      rotating.release();
      await pool.end();
    }
  });
}
