import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  Pool,
  apiBaseUrl,
  canonicalOutboxPayloadChecksum,
  checkDatabaseReadiness,
  createFailureNotificationStore,
  createInput,
  databaseUrl,
  historicalDestinationId,
  historicalDispatchingIntentId,
  historicalIntentId,
  historicalOutboxByIntent,
  historicalRetryIntentId,
  historicalRunId,
  historicalWorkspaceId,
  migrationBaseUrl,
  ownerA,
  ownerB,
  parseDatabaseConfig,
  pgCode,
  priorDatabaseName,
  randomUUID,
  registerCurrentConnectionsFixture,
  upgradeDatabaseName,
  workerBaseUrl,
  workspaceA,
  workspaceB,
} from './support/connections.integration.support.js';
import {
  priorApplied,
  upgradeApplied,
} from './support/connections-compatibility.integration.support.js';

const connections = registerCurrentConnectionsFixture();
import { expectedMigrationHistoryFrom } from './support/migration-history-fixture.js';

describe('connection persistence', () => {
  it('idempotently manages immutable failure-notification destinations and workflow policy', async () => {
    const connection = createInput({
      providerKey: 'email',
      authType: 'resend_api_key',
      name: `Email ${randomUUID()}`,
    });
    await connections.api.createConnection(connection);
    expect(connection.connectionId[14]).toBe('7');
    const workflowId = randomUUID();
    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    let ownerClient: PoolClient | undefined;
    try {
      ownerClient = await owner.connect();
      await ownerClient.query('begin');
      await ownerClient.query('set local role pertexo_owner');
      await ownerClient.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await ownerClient.query(
        `insert into app.workflows (id,workspace_id,name,created_by)
         values ($1,$2,'Notification policy',$3)`,
        [workflowId, workspaceA, ownerA],
      );
      await ownerClient.query('commit');
    } finally {
      await ownerClient?.query('rollback').catch(() => undefined);
      ownerClient?.release();
      await owner.end();
    }

    const destinationId = randomUUID();
    const create = {
      workspaceId: workspaceA,
      actorId: ownerA,
      destinationId,
      config: {
        kind: 'email' as const,
        connectionId: connection.connectionId,
        toEmail: 'Ops@EXAMPLE.TEST',
      },
      idempotencyKey: `destination-create-${destinationId}`,
      requestHash: '1'.repeat(64),
      requestId: `request-${destinationId}`,
    };
    const created = await connections.destinations.create(create);
    expect(created.config).toMatchObject({ toEmail: 'Ops@example.test' });
    await expect(
      connections.destinations.get({
        workspaceId: workspaceA,
        actorId: ownerA,
        destinationId,
      }),
    ).resolves.toEqual(created);
    await expect(
      connections.destinations.list({
        workspaceId: workspaceA,
        actorId: ownerA,
      }),
    ).resolves.toContainEqual(created);
    const replayed = await connections.destinations.create({
      ...create,
      destinationId: randomUUID(),
    });
    expect(replayed).toEqual(created);
    await expect(
      connections.destinations.create({
        ...create,
        requestHash: '2'.repeat(64),
      }),
    ).rejects.toMatchObject({
      code: 'idempotency_conflict',
      name: 'FailureNotificationDestinationError',
    });

    const append = {
      ...create,
      destinationId,
      expectedVersion: 1,
      config: { ...create.config, toEmail: 'alerts@example.test' },
      idempotencyKey: `destination-append-${destinationId}`,
      requestHash: '3'.repeat(64),
    };
    const appended = await connections.destinations.appendVersion(append);
    await expect(
      connections.destinations.appendVersion(append),
    ).resolves.toEqual(appended);
    expect(appended).toMatchObject({
      currentVersion: 2,
      config: { toEmail: 'alerts@example.test' },
    });

    const setPolicy = {
      workspaceId: workspaceA,
      actorId: ownerA,
      workflowId,
      destinationId,
      idempotencyKey: `policy-set-${workflowId}`,
      requestHash: '4'.repeat(64),
    };
    const readPolicy = { workspaceId: workspaceA, actorId: ownerA, workflowId };
    await expect(
      connections.destinations.getWorkflowPolicy(readPolicy),
    ).resolves.toBeNull();
    await connections.destinations.setWorkflowPolicy(setPolicy);
    await connections.destinations.setWorkflowPolicy(setPolicy);
    await expect(
      connections.destinations.getWorkflowPolicy(readPolicy),
    ).resolves.toEqual(appended);
    await expect(
      connections.destinations.getWorkflowPolicy({
        workspaceId: workspaceB,
        actorId: ownerB,
        workflowId,
      }),
    ).rejects.toMatchObject({
      code: 'not_found',
      name: 'FailureNotificationDestinationError',
    });
    const statusNoop = {
      workspaceId: workspaceA,
      actorId: ownerA,
      destinationId,
      status: 'enabled' as const,
      idempotencyKey: `destination-status-noop-${destinationId}`,
      requestHash: '7'.repeat(64),
    };
    await expect(
      connections.destinations.setStatus(statusNoop),
    ).resolves.toEqual(appended);
    const status = {
      workspaceId: workspaceA,
      actorId: ownerA,
      destinationId,
      status: 'disabled' as const,
      idempotencyKey: `destination-status-${destinationId}`,
      requestHash: '5'.repeat(64),
    };
    await connections.destinations.setStatus(status);
    await expect(
      connections.destinations.setStatus(status),
    ).resolves.toMatchObject({
      status: 'disabled',
    });
    // A disabled destination stays the workflow's current choice until changed.
    await expect(
      connections.destinations.getWorkflowPolicy(readPolicy),
    ).resolves.toMatchObject({ id: destinationId, status: 'disabled' });
    await expect(
      connections.destinations.list({
        workspaceId: workspaceB,
        actorId: ownerB,
      }),
    ).resolves.toEqual([]);
    const clearPolicy = {
      workspaceId: workspaceA,
      actorId: ownerA,
      workflowId,
      idempotencyKey: `policy-clear-${workflowId}`,
      requestHash: '6'.repeat(64),
    };
    await connections.destinations.clearWorkflowPolicy(clearPolicy);
    await connections.destinations.clearWorkflowPolicy(clearPolicy);
    await expect(
      connections.destinations.getWorkflowPolicy(readPolicy),
    ).resolves.toBeNull();
    await expect(
      connections.destinations.clearWorkflowPolicy({
        ...clearPolicy,
        idempotencyKey: `${clearPolicy.idempotencyKey}-absent`,
        requestHash: '8'.repeat(64),
      }),
    ).resolves.toBeUndefined();
    await expect(
      connections.destinations.create({
        ...create,
        destinationId: randomUUID(),
      }),
    ).resolves.toEqual(created);
    await expect(
      connections.destinations.appendVersion(append),
    ).resolves.toEqual(appended);
    const deletion = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
    });
    let deletionClient: PoolClient | undefined;
    try {
      deletionClient = await deletion.connect();
      await deletionClient.query('begin');
      await deletionClient.query('set local role pertexo_owner');
      await deletionClient.query(
        "select set_config('app.workspace_id',$1,true)",
        [workspaceA],
      );
      await deletionClient.query('delete from app.workflows where id=$1', [
        workflowId,
      ]);
      await deletionClient.query('commit');
    } finally {
      await deletionClient?.query('rollback').catch(() => undefined);
      deletionClient?.release();
      await deletion.end();
    }
    await expect(
      connections.destinations.clearWorkflowPolicy(clearPolicy),
    ).resolves.toBeUndefined();
    await expect(
      connections.destinations.clearWorkflowPolicy({
        ...clearPolicy,
        idempotencyKey: `${clearPolicy.idempotencyKey}-new`,
      }),
    ).rejects.toMatchObject({
      code: 'not_found',
      name: 'FailureNotificationDestinationError',
    });
    await expect(
      connections.destinations.getWorkflowPolicy(readPolicy),
    ).rejects.toMatchObject({ code: 'not_found' });

    const audit = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    let auditClient: PoolClient | undefined;
    try {
      auditClient = await audit.connect();
      await auditClient.query('begin');
      await auditClient.query('set local role pertexo_owner');
      await auditClient.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      const result = await auditClient.query<{
        action: string;
        actor_user_id: string;
        metadata: Record<string, unknown>;
        request_id: string | null;
        target_id: string;
        target_type: string;
        trace_id: string | null;
      }>(
        `select action,actor_user_id::text,target_type,target_id::text,
                request_id,trace_id,metadata
           from app.audit_events
          where target_id in ($1,$2)
            and action in (
              'failure_notification_destination.created',
              'failure_notification_destination.version_appended',
              'failure_notification_destination.enabled',
              'failure_notification_destination.disabled',
              'workflow.failure_notification_policy_set',
              'workflow.failure_notification_policy_cleared'
            )
          order by action`,
        [destinationId, workflowId],
      );
      expect(result.rows).toEqual([
        {
          action: 'failure_notification_destination.created',
          actor_user_id: ownerA,
          metadata: { kind: 'email', version: 1 },
          request_id: create.requestId,
          target_id: destinationId,
          target_type: 'failure_notification_destination',
          trace_id: null,
        },
        {
          action: 'failure_notification_destination.disabled',
          actor_user_id: ownerA,
          metadata: {},
          request_id: null,
          target_id: destinationId,
          target_type: 'failure_notification_destination',
          trace_id: null,
        },
        {
          action: 'failure_notification_destination.version_appended',
          actor_user_id: ownerA,
          metadata: { version: 2 },
          request_id: create.requestId,
          target_id: destinationId,
          target_type: 'failure_notification_destination',
          trace_id: null,
        },
        {
          action: 'workflow.failure_notification_policy_cleared',
          actor_user_id: ownerA,
          metadata: {},
          request_id: null,
          target_id: workflowId,
          target_type: 'workflow',
          trace_id: null,
        },
        {
          action: 'workflow.failure_notification_policy_set',
          actor_user_id: ownerA,
          metadata: { destinationId },
          request_id: null,
          target_id: workflowId,
          target_type: 'workflow',
          trace_id: null,
        },
      ]);
    } finally {
      await auditClient?.query('rollback').catch(() => undefined);
      auditClient?.release();
      await audit.end();
    }
  });

  it('enforces destination capabilities, active authority, and workflow visibility', async () => {
    const connection = createInput({
      providerKey: 'email',
      authType: 'resend_api_key',
      name: `Destination roles ${randomUUID()}`,
    });
    await connections.api.createConnection(connection);
    const roleActors = new Map([
      ['owner', ownerA],
      ...(['admin', 'builder', 'operator', 'viewer'] as const).map(
        (role) => [role, randomUUID()] as const,
      ),
    ] as const);
    const workflowIds = new Map(
      [...roleActors.keys()].map((role) => [role, randomUUID()] as const),
    );
    const otherWorkspaceWorkflowId = randomUUID();
    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    let client: PoolClient | undefined;
    try {
      client = await owner.connect();
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      for (const [role, actorId] of roleActors) {
        if (role !== 'owner') {
          await client.query(
            `insert into app.users (id,email,display_name,status)
             values ($1,$2,$3,'active')`,
            [actorId, `${actorId}@example.test`, `Destination ${role}`],
          );
          await client.query(
            `insert into app.workspace_memberships
               (workspace_id,user_id,role,status)
             values ($1,$2,$3,'active')`,
            [workspaceA, actorId, role],
          );
        }
        await client.query(
          `insert into app.workflows (id,workspace_id,name,created_by)
           values ($1,$2,$3,$4)`,
          [
            workflowIds.get(role),
            workspaceA,
            `Destination role ${role}`,
            ownerA,
          ],
        );
      }
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceB,
      ]);
      await client.query(
        `insert into app.workflows (id,workspace_id,name,created_by)
         values ($1,$2,'Other workspace policy',$3)`,
        [otherWorkspaceWorkflowId, workspaceB, ownerB],
      );
      await client.query('commit');
    } finally {
      await client?.query('rollback').catch(() => undefined);
      client?.release();
      await owner.end();
    }

    const destinationId = randomUUID();
    const destinationConfig = {
      kind: 'email' as const,
      connectionId: connection.connectionId,
      toEmail: 'roles@example.test',
    };
    const destination = await connections.destinations.create({
      workspaceId: workspaceA,
      actorId: ownerA,
      destinationId,
      config: destinationConfig,
      idempotencyKey: `role-base-${destinationId}`,
      requestHash: '9'.repeat(64),
    });

    for (const [role, actorId] of roleActors) {
      const readable = ['owner', 'admin', 'builder'].includes(role);
      if (readable) {
        await expect(
          connections.destinations.get({
            workspaceId: workspaceA,
            actorId,
            destinationId,
          }),
        ).resolves.toEqual(destination);
        await expect(
          connections.destinations.list({
            workspaceId: workspaceA,
            actorId,
          }),
        ).resolves.toContainEqual(destination);
      } else {
        await expect(
          connections.destinations.get({
            workspaceId: workspaceA,
            actorId,
            destinationId,
          }),
        ).rejects.toMatchObject({ code: 'not_found' });
        await expect(
          connections.destinations.list({
            workspaceId: workspaceA,
            actorId,
          }),
        ).rejects.toMatchObject({ code: 'not_found' });
      }

      const candidateId = randomUUID();
      const create = connections.destinations.create({
        workspaceId: workspaceA,
        actorId,
        destinationId: candidateId,
        config: destinationConfig,
        idempotencyKey: `role-create-${role}-${candidateId}`,
        requestHash: 'a'.repeat(64),
      });
      if (role === 'owner' || role === 'admin')
        await expect(create).resolves.toMatchObject({ id: candidateId });
      else await expect(create).rejects.toMatchObject({ code: 'not_found' });

      const workflowId = workflowIds.get(role);
      if (workflowId === undefined) throw new Error('Role workflow missing');
      const policy = {
        workspaceId: workspaceA,
        actorId,
        workflowId,
        destinationId,
        idempotencyKey: `role-policy-${role}-${workflowId}`,
        requestHash: 'b'.repeat(64),
      };
      const read = connections.destinations.getWorkflowPolicy({
        workspaceId: workspaceA,
        actorId,
        workflowId,
      });
      if (readable) {
        await expect(read).resolves.toBeNull();
        await expect(
          connections.destinations.setWorkflowPolicy(policy),
        ).resolves.toBeUndefined();
        await expect(
          connections.destinations.getWorkflowPolicy({
            workspaceId: workspaceA,
            actorId,
            workflowId,
          }),
        ).resolves.toEqual(destination);
        await expect(
          connections.destinations.clearWorkflowPolicy({
            ...policy,
            idempotencyKey: `role-policy-clear-${role}-${workflowId}`,
            requestHash: 'c'.repeat(64),
          }),
        ).resolves.toBeUndefined();
      } else {
        await expect(read).rejects.toMatchObject({ code: 'not_found' });
        await expect(
          connections.destinations.setWorkflowPolicy(policy),
        ).rejects.toMatchObject({ code: 'not_found' });
        await expect(
          connections.destinations.clearWorkflowPolicy({
            ...policy,
            idempotencyKey: `role-policy-clear-${role}-${workflowId}`,
            requestHash: 'c'.repeat(64),
          }),
        ).rejects.toMatchObject({ code: 'not_found' });
      }
    }

    const adminId = roleActors.get('admin');
    const builderId = roleActors.get('builder');
    if (adminId === undefined || builderId === undefined)
      throw new Error('Destination authority fixtures are missing');
    await expect(
      connections.destinations.appendVersion({
        workspaceId: workspaceA,
        actorId: adminId,
        destinationId,
        expectedVersion: 1,
        config: { ...destinationConfig, toEmail: 'admin@example.test' },
        idempotencyKey: `admin-append-${destinationId}`,
        requestHash: 'd'.repeat(64),
      }),
    ).resolves.toMatchObject({ currentVersion: 2 });
    await expect(
      connections.destinations.appendVersion({
        workspaceId: workspaceA,
        actorId: builderId,
        destinationId,
        expectedVersion: 2,
        config: { ...destinationConfig, toEmail: 'builder@example.test' },
        idempotencyKey: `builder-append-${destinationId}`,
        requestHash: 'e'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      connections.destinations.setStatus({
        workspaceId: workspaceA,
        actorId: builderId,
        destinationId,
        status: 'disabled',
        idempotencyKey: `builder-status-${destinationId}`,
        requestHash: 'f'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const adminReplayCommand = {
      workspaceId: workspaceA,
      actorId: adminId,
      destinationId,
      status: 'enabled' as const,
      idempotencyKey: `admin-status-replay-${destinationId}`,
      requestHash: '1'.repeat(64),
    };
    await expect(
      connections.destinations.setStatus(adminReplayCommand),
    ).resolves.toMatchObject({ status: 'enabled' });
    await expect(
      connections.destinations.setWorkflowPolicy({
        workspaceId: workspaceA,
        actorId: builderId,
        workflowId: otherWorkspaceWorkflowId,
        destinationId,
        idempotencyKey: `foreign-workflow-${otherWorkspaceWorkflowId}`,
        requestHash: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      connections.destinations.get({
        workspaceId: workspaceB,
        actorId: ownerB,
        destinationId,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      connections.destinations.getWorkflowPolicy({
        workspaceId: workspaceA,
        actorId: builderId,
        workflowId: otherWorkspaceWorkflowId,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    const authority = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
    });
    try {
      await authority.query('set role pertexo_owner');
      await authority.query("select set_config('app.workspace_id',$1,false)", [
        workspaceA,
      ]);
      const assertInactiveDenied = async (): Promise<void> => {
        await expect(
          connections.destinations.get({
            workspaceId: workspaceA,
            actorId: adminId,
            destinationId,
          }),
        ).rejects.toMatchObject({ code: 'not_found' });
        await expect(
          connections.destinations.setStatus(adminReplayCommand),
        ).rejects.toMatchObject({ code: 'not_found' });
      };
      await authority.query(
        `update app.workspace_memberships set status='suspended'
          where workspace_id=$1 and user_id=$2`,
        [workspaceA, adminId],
      );
      await assertInactiveDenied();
      await authority.query(
        `update app.workspace_memberships set status='active'
          where workspace_id=$1 and user_id=$2`,
        [workspaceA, adminId],
      );
      await authority.query(
        `update app.users set status='suspended' where id=$1`,
        [adminId],
      );
      await assertInactiveDenied();
      await authority.query(
        `update app.users set status='active' where id=$1`,
        [adminId],
      );
      await authority.query(
        `update app.workspaces set status='suspended' where id=$1`,
        [workspaceA],
      );
      await assertInactiveDenied();
    } finally {
      await authority
        .query(
          `update app.workspace_memberships set status='active'
            where workspace_id=$1 and user_id=$2`,
          [workspaceA, adminId],
        )
        .catch(() => undefined);
      await authority
        .query(`update app.users set status='active' where id=$1`, [adminId])
        .catch(() => undefined);
      await authority
        .query(`update app.workspaces set status='active' where id=$1`, [
          workspaceA,
        ])
        .catch(() => undefined);
      await authority.end();
    }
  });

  it('admits exactly one optimistic destination append at a version boundary', async () => {
    const connection = createInput({
      providerKey: 'email',
      authType: 'resend_api_key',
      name: `Destination append ${randomUUID()}`,
    });
    await connections.api.createConnection(connection);
    const destinationId = randomUUID();
    const base = {
      workspaceId: workspaceA,
      actorId: ownerA,
      destinationId,
      config: {
        kind: 'email' as const,
        connectionId: connection.connectionId,
        toEmail: 'base@example.test',
      },
    };
    await connections.destinations.create({
      ...base,
      idempotencyKey: `append-base-${destinationId}`,
      requestHash: '1'.repeat(64),
    });
    const append = (suffix: string) =>
      connections.destinations
        .appendVersion({
          ...base,
          expectedVersion: 1,
          config: { ...base.config, toEmail: `${suffix}@example.test` },
          idempotencyKey: `append-race-${suffix}-${destinationId}`,
          requestHash: suffix.repeat(64),
        })
        .then(
          (value) => ({ kind: 'appended' as const, value }),
          (error: unknown) => ({ kind: 'failed' as const, error }),
        );
    const outcomes = await Promise.all([append('a'), append('b')]);
    const appended = outcomes.filter((outcome) => outcome.kind === 'appended');
    const failed = outcomes.filter((outcome) => outcome.kind === 'failed');
    expect(appended).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.kind === 'failed' && failed[0].error).toMatchObject({
      code: 'conflict',
      name: 'FailureNotificationDestinationError',
    });
    await expect(
      connections.destinations.get({
        workspaceId: workspaceA,
        actorId: ownerA,
        destinationId,
      }),
    ).resolves.toMatchObject({
      currentVersion: 2,
      config: appended[0]?.kind === 'appended' ? appended[0].value.config : {},
    });

    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    try {
      await owner.query('set role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,false)", [
        workspaceA,
      ]);
      await expect(
        owner.query<{ version_count: number }>(
          `select count(*)::int version_count
             from app.failure_notification_destination_versions
            where workspace_id=$1 and destination_id=$2`,
          [workspaceA, destinationId],
        ),
      ).resolves.toMatchObject({ rows: [{ version_count: 2 }] });
    } finally {
      await owner.end();
    }
  });

  it('upgrades populated exact 0036 notification rows without fabricating destination config', async () => {
    expect(priorApplied).toEqual(
      await expectedMigrationHistoryFrom(
        '0037_failure_notification_destinations.sql',
      ),
    );
    const pool = new Pool({
      connectionString: databaseUrl(apiBaseUrl, priorDatabaseName),
      max: 1,
    });
    try {
      await expect(
        checkDatabaseReadiness(pool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).resolves.toMatchObject({
        migrationHead: '0113_workflow_run_statistics_index.sql',
      });
      const bindingSurface = await pool.query<{
        node_column: boolean;
        node_constraint: boolean;
        node_worker_update: boolean;
        preview_column: boolean;
        preview_constraint: boolean;
        preview_worker_update: boolean;
      }>(
        `select
           exists (
             select 1 from information_schema.columns
             where table_schema='app' and table_name='node_runs'
               and column_name='provider_dispatch_binding'
               and data_type='character varying' and character_maximum_length=128
           ) node_column,
           exists (
             select 1 from pg_constraint
             where conrelid='app.node_runs'::regclass
               and conname='node_runs_provider_dispatch_binding_format'
           ) node_constraint,
           has_column_privilege(
             'pertexo_worker','app.node_runs','provider_dispatch_binding','UPDATE'
           ) node_worker_update,
           exists (
             select 1 from information_schema.columns
             where table_schema='app' and table_name='preview_attempts'
               and column_name='provider_dispatch_binding'
               and data_type='character varying' and character_maximum_length=128
           ) preview_column,
           exists (
             select 1 from pg_constraint
             where conrelid='app.preview_attempts'::regclass
               and conname='preview_attempts_provider_dispatch_binding_format'
           ) preview_constraint,
           has_column_privilege(
             'pertexo_worker','app.preview_attempts','provider_dispatch_binding','UPDATE'
           ) preview_worker_update`,
      );
      expect(bindingSurface.rows[0]).toEqual({
        node_column: true,
        node_constraint: true,
        node_worker_update: true,
        preview_column: true,
        preview_constraint: true,
        preview_worker_update: true,
      });
      const historicalPool = new Pool({
        connectionString: databaseUrl(migrationBaseUrl, priorDatabaseName),
        max: 1,
      });
      let historicalClient: PoolClient | undefined;
      try {
        historicalClient = await historicalPool.connect();
        await historicalClient.query('begin');
        await historicalClient.query('set local role pertexo_owner');
        await historicalClient.query(
          'alter table app.run_failure_notification_intents no force row level security',
        );
        await historicalClient.query(
          'alter table app.run_failure_notification_audit_facts no force row level security',
        );
        await historicalClient.query(
          "select set_config('app.workspace_id',$1,true)",
          [historicalWorkspaceId],
        );
        const historical = await historicalClient.query<{
          audit_count: string;
          completed_count: string;
          intent_secret: string | null;
          run_secret: string | null;
          dead_letter_count: string;
          ambiguous_count: string;
          unvalidated_fks: string;
        }>(
          `select
             (select connection_secret_version_id::text
                from app.run_failure_notification_intents where id=$1) intent_secret,
              (select failure_notification_connection_secret_version_id::text
                 from app.workflow_runs where id=$2) run_secret,
               (select count(*)::text from app.run_failure_notification_intents
                 where id=any($3::uuid[]) and status='dead_letter'
                   and safe_error_code='delivery.destination_unavailable'
                   and possibly_dispatched=false
                   and completed_at is not null and recovery_at is null
                   and next_delivery_at is null and dispatch_marked_at is null) dead_letter_count,
               (select count(*)::text from app.run_failure_notification_intents
                 where id=$4 and status='outcome_unknown'
                   and safe_error_code='delivery.recovery_ambiguous'
                   and possibly_dispatched=true and completed_at is not null
                   and recovery_at is null and next_delivery_at is null
                   and dispatch_marked_at is null) ambiguous_count,
              (select count(*)::text from app.run_failure_notification_intents
                where id=any($3::uuid[]) and completed_at is not null) completed_count,
              (select count(*)::text from app.run_failure_notification_audit_facts
                where notification_intent_id=any($3::uuid[])
                   and ((notification_intent_id=$4 and fact_type='outcome_unknown'
                         and safe_error_code='delivery.recovery_ambiguous'
                         and possibly_dispatched=true)
                     or (notification_intent_id<>$4 and fact_type='dead_lettered'
                         and safe_error_code='delivery.destination_unavailable'
                         and possibly_dispatched=false))) audit_count,
              (select count(*)::text from pg_constraint
               where conname in (
                 'workflow_runs_failure_notification_destination_version_fk',
                 'run_failure_notification_intents_destination_version_fk'
               ) and not convalidated) unvalidated_fks`,
          [
            historicalIntentId,
            historicalRunId,
            [
              historicalIntentId,
              historicalRetryIntentId,
              historicalDispatchingIntentId,
            ],
            historicalDispatchingIntentId,
          ],
        );
        expect(historical.rows[0]).toEqual({
          audit_count: '3',
          ambiguous_count: '1',
          completed_count: '3',
          dead_letter_count: '2',
          intent_secret: null,
          run_secret: null,
          unvalidated_fks: '2',
        });
        await expect(
          historicalClient.query(
            `insert into app.run_failure_notification_intents (
               id,workspace_id,workflow_run_id,terminal_event_sequence,policy_version,
               destination_id,destination_config_version,side_effect_class,context,
               context_checksum
             ) values ($1,$2,$3,2,1,$4,8,'safe','{}'::jsonb,$5)`,
            [
              randomUUID(),
              historicalWorkspaceId,
              historicalRunId,
              historicalDestinationId,
              'b'.repeat(64),
            ],
          ),
        ).rejects.toSatisfy(pgCode('23503'));
      } finally {
        await historicalClient?.query('rollback').catch(() => undefined);
        historicalClient?.release();
        await historicalPool.end();
      }
      const historicalStore = createFailureNotificationStore(
        parseDatabaseConfig({
          connectionString: databaseUrl(workerBaseUrl, priorDatabaseName),
          max: 1,
        }),
      );
      try {
        for (const [intentId, outboxEventId] of historicalOutboxByIntent) {
          const payload = {
            schemaVersion: 1 as const,
            workspaceId: historicalWorkspaceId,
            notificationIntentId: intentId,
            outboxEventId,
          };
          await expect(
            historicalStore.claimDelivery({
              workspaceId: historicalWorkspaceId,
              intentId,
              delivery: {
                outboxEventId,
                payloadChecksum: canonicalOutboxPayloadChecksum(payload),
              },
              recoverySeconds: 1,
              maxAttempts: 3,
            }),
          ).resolves.toEqual({ kind: 'terminal' });
        }
      } finally {
        await historicalStore.close();
      }
    } finally {
      await pool.end();
    }
  });

  it('upgrades the supported pre-phase-4 head through all later migrations', async () => {
    expect(upgradeApplied).toEqual(
      await expectedMigrationHistoryFrom('0021_workflow_integration_usage.sql'),
    );
    const pool = new Pool({
      connectionString: databaseUrl(apiBaseUrl, upgradeDatabaseName),
      max: 1,
    });
    try {
      await expect(
        checkDatabaseReadiness(pool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).resolves.toMatchObject({
        migrationHead: '0113_workflow_run_statistics_index.sql',
      });
    } finally {
      await pool.end();
    }
  });
});
