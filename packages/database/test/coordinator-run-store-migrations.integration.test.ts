import { describe, it, expect } from 'vitest';

import {
  Pool,
  adminBaseUrl,
  apiBaseUrl,
  asOwner,
  asRuntime,
  checkDatabaseReadiness,
  databaseUrl,
  dropDisconnectedDatabase,
  insertRun,
  migrateDatabase,
  migrateThrough0030,
  migrationBaseUrl,
  migrationConfig,
  namedDatabaseUrl,
  priorHeadDatabaseName,
  randomUUID,
  retainedRunId,
  ownedDeliveryStore,
  versionA,
  workerBaseUrl,
  workspaceA,
  zeroDatabaseName,
} from './coordinator-run-store.fixtures.js';
import { expectedMigrationHistoryFrom } from './support/migration-history-fixture.js';

describe('Coordinator migration and identity invariants', () => {
  it('migrates a zero database through the current head and retains the 0016 contract', async () => {
    const admin = new Pool({ connectionString: adminBaseUrl, max: 1 });
    try {
      await admin.query(
        `drop database if exists "${zeroDatabaseName}" with (force)`,
      );
      await admin.query(
        `create database "${zeroDatabaseName}" owner pertexo_owner`,
      );
      await admin.query(
        `revoke all on database "${zeroDatabaseName}" from public`,
      );
      await admin.query(
        `grant connect on database "${zeroDatabaseName}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher`,
      );
      await migrateDatabase({
        ...migrationConfig,
        connectionString: namedDatabaseUrl(migrationBaseUrl, zeroDatabaseName),
      });
      const readinessPool = new Pool({
        connectionString: namedDatabaseUrl(workerBaseUrl, zeroDatabaseName),
        max: 1,
      });
      try {
        await expect(
          checkDatabaseReadiness(readinessPool, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
          }),
        ).resolves.toMatchObject({
          migrationHead: '0113_workflow_run_statistics_index.sql',
          role: 'pertexo_worker',
        });
      } finally {
        await readinessPool.end();
      }
    } finally {
      try {
        await dropDisconnectedDatabase(admin, zeroDatabaseName);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  it('upgrades the 0030 head through the current head and retains 0031 wakeup authority', async () => {
    const admin = new Pool({ connectionString: adminBaseUrl, max: 1 });
    const priorConfig = {
      ...migrationConfig,
      connectionString: namedDatabaseUrl(
        migrationBaseUrl,
        priorHeadDatabaseName,
      ),
    };
    try {
      await admin.query(
        `drop database if exists "${priorHeadDatabaseName}" with (force)`,
      );
      await admin.query(
        `create database "${priorHeadDatabaseName}" owner pertexo_owner`,
      );
      await admin.query(
        `revoke all on database "${priorHeadDatabaseName}" from public`,
      );
      await admin.query(
        `grant connect on database "${priorHeadDatabaseName}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher`,
      );
      await migrateThrough0030(priorConfig);
      const migrationPool = new Pool({
        connectionString: namedDatabaseUrl(
          workerBaseUrl,
          priorHeadDatabaseName,
        ),
        max: 1,
      });
      try {
        await expect(
          migrationPool.query<{ name: string }>(
            `select name from pertexo_internal.schema_migrations
               order by name desc limit 1`,
          ),
        ).resolves.toMatchObject({
          rows: [{ name: '0030_coordinator_retry_decisions.sql' }],
        });
      } finally {
        await migrationPool.end();
      }

      await expect(migrateDatabase(priorConfig)).resolves.toEqual(
        await expectedMigrationHistoryFrom('0031_due_node_wakeups.sql'),
      );
      const workerPool = new Pool({
        connectionString: namedDatabaseUrl(
          workerBaseUrl,
          priorHeadDatabaseName,
        ),
        max: 1,
      });
      try {
        await expect(
          checkDatabaseReadiness(workerPool, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
          }),
        ).resolves.toMatchObject({
          migrationHead: '0113_workflow_run_statistics_index.sql',
          role: 'pertexo_worker',
        });
        await expect(
          workerPool.query<{ claimed: number }>(
            'select app.claim_due_node_run_wakeups(10)::integer claimed',
          ),
        ).resolves.toMatchObject({ rows: [{ claimed: 0 }] });
        await expect(
          workerPool.query<{
            column_present: boolean;
            execute_granted: boolean;
            function_owner: string;
            function_security_definer: boolean;
            update_granted: boolean;
          }>(
            `select
                 exists (
                   select 1 from pg_attribute
                   where attrelid='app.node_runs'::regclass
                     and attname='due_wakeup_at' and not attisdropped
                 ) column_present,
                 has_function_privilege(
                   'pertexo_worker',
                   'app.claim_due_node_run_wakeups(integer)',
                   'EXECUTE'
                 ) execute_granted,
                 has_column_privilege(
                   'pertexo_worker','app.node_runs','due_wakeup_at','UPDATE'
                 ) update_granted,
                 pg_get_userbyid(proowner) function_owner,
                 prosecdef function_security_definer
               from pg_proc
               where oid='app.claim_due_node_run_wakeups(integer)'::regprocedure`,
          ),
        ).resolves.toMatchObject({
          rows: [
            {
              column_present: true,
              execute_granted: true,
              function_owner: 'pertexo_owner',
              function_security_definer: true,
              update_granted: true,
            },
          ],
        });
      } finally {
        await workerPool.end();
      }
    } finally {
      try {
        await dropDisconnectedDatabase(admin, priorHeadDatabaseName);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  it('retains the 0014 identity upgrade at the current head and fails closed for legacy checkpoints', async () => {
    const readinessPool = new Pool({
      connectionString: databaseUrl(workerBaseUrl),
      max: 1,
    });
    try {
      await expect(
        checkDatabaseReadiness(readinessPool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).resolves.toMatchObject({
        migrationHead: '0113_workflow_run_statistics_index.sql',
        role: 'pertexo_worker',
      });
      const catalog = await readinessPool.query<{
        event_payload_constraint: boolean;
        fingerprint_column: boolean;
        fingerprint_constraint: boolean;
        fingerprint_update: boolean;
        required_updates: boolean;
      }>(
        `select
             exists (
               select 1 from pg_constraint
               where conrelid='app.run_events'::regclass
                 and conname='run_events_payload_bounded'
                 and pg_get_constraintdef(oid) =
                   'CHECK ((octet_length((payload)::text) <= 524288))'
             ) event_payload_constraint,
             exists (
               select 1 from pg_attribute
               where attrelid='app.run_checkpoints'::regclass
                 and attname='last_transition_fingerprint'
                 and atttypid='character varying'::regtype and atttypmod=68
                 and not attnotnull and not attisdropped
             ) fingerprint_column,
             exists (
               select 1 from pg_constraint
               where conrelid='app.run_checkpoints'::regclass
                 and conname='run_checkpoints_transition_fingerprint_valid'
                 and pg_get_constraintdef(oid) =
                   'CHECK (((last_transition_fingerprint IS NULL) OR ((last_transition_fingerprint)::text ~ ''^[0-9a-f]{64}$''::text)))'
             ) fingerprint_constraint,
             has_column_privilege('pertexo_worker','app.run_checkpoints','last_transition_fingerprint','UPDATE') fingerprint_update,
             not exists (
               select 1 from (values
                 ('workflow_runs','status'),('workflow_runs','started_at'),
                 ('workflow_runs','completed_at'),('workflow_runs','updated_at'),
                 ('run_checkpoints','revision'),('run_checkpoints','engine_version'),
                 ('run_checkpoints','scheduler_state'),
                 ('run_checkpoints','last_transition_fingerprint'),
                 ('run_checkpoints','resume_at'),
                 ('run_checkpoints','resume_lease_owner'),
                 ('run_checkpoints','resume_lease_token'),
                 ('run_checkpoints','resume_lease_expires_at'),
                 ('run_checkpoints','updated_at'),('node_runs','status'),
                 ('node_runs','current_attempt_id'),
                 ('node_runs','current_attempt_number'),('node_runs','resume_at'),
                 ('node_runs','retry_due_at'),('node_runs','completed_at'),
                 ('node_runs','safe_error_code'),('node_runs','updated_at'),
                 ('node_attempts','status')
               ) required(table_name,column_name)
               where not has_column_privilege(
                 'pertexo_worker','app.'||table_name,column_name,'UPDATE'
               )
             ) required_updates`,
      );
      expect(catalog.rows[0]).toEqual({
        event_payload_constraint: true,
        fingerprint_column: true,
        fingerprint_constraint: true,
        fingerprint_update: true,
        required_updates: true,
      });
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            `update app.run_checkpoints
               set last_transition_fingerprint=$1
               where workflow_run_id=$2`,
            ['A'.repeat(64), retainedRunId],
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });

      await asOwner(workspaceA, (client) =>
        client.query(
          'revoke update (last_transition_fingerprint) on app.run_checkpoints from pertexo_worker',
        ),
      );
      try {
        await expect(
          checkDatabaseReadiness(readinessPool, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
          }),
        ).rejects.toThrow('Coordinator RunStore grants are incompatible');
      } finally {
        await asOwner(workspaceA, (client) =>
          client.query(
            'grant update (last_transition_fingerprint) on app.run_checkpoints to pertexo_worker',
          ),
        );
      }
      await asOwner(workspaceA, (client) =>
        client.query('grant update on app.outbox_events to pertexo_worker'),
      );
      try {
        await expect(
          checkDatabaseReadiness(readinessPool, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
          }),
        ).rejects.toThrow('Coordinator RunStore grants are incompatible');
      } finally {
        await asOwner(workspaceA, (client) =>
          client.query(
            'revoke update on app.outbox_events from pertexo_worker',
          ),
        );
      }
      for (const [revoke, restore] of [
        [
          'revoke select on app.outbox_events from pertexo_worker',
          'grant select on app.outbox_events to pertexo_worker',
        ],
        [
          'revoke insert on app.transport_security_audit_facts from pertexo_worker',
          'grant insert on app.transport_security_audit_facts to pertexo_worker',
        ],
      ] as const) {
        await asOwner(workspaceA, (client) => client.query(revoke));
        try {
          await expect(
            checkDatabaseReadiness(readinessPool, {
              ownerRole: 'pertexo_owner',
              workerRuntimeRole: 'pertexo_worker',
            }),
          ).rejects.toThrow('Coordinator RunStore grants are incompatible');
        } finally {
          await asOwner(workspaceA, (client) => client.query(restore));
        }
      }
      await asOwner(workspaceA, (client) =>
        client.query(
          `alter policy inbox_receipts_workspace_scope on app.inbox_receipts
             using (true) with check (true)`,
        ),
      );
      try {
        await expect(
          checkDatabaseReadiness(readinessPool, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
          }),
        ).rejects.toThrow('Coordinator RunStore grants are incompatible');
      } finally {
        await asOwner(workspaceA, (client) =>
          client.query(
            `alter policy inbox_receipts_workspace_scope on app.inbox_receipts
               using (
                 workspace_id::text = nullif(
                   current_setting('app.workspace_id', true), ''
                 )
               )
               with check (
                 workspace_id::text = nullif(
                   current_setting('app.workspace_id', true), ''
                 )
               )`,
          ),
        );
      }

      await asOwner(workspaceA, (client) =>
        client.query(
          'alter table app.run_checkpoints drop constraint run_checkpoints_transition_fingerprint_valid',
        ),
      );
      try {
        await expect(
          checkDatabaseReadiness(readinessPool, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
          }),
        ).rejects.toThrow('Execution value persistence is incompatible');
      } finally {
        await asOwner(workspaceA, (client) =>
          client.query(
            `alter table app.run_checkpoints
               add constraint run_checkpoints_transition_fingerprint_valid
               check (
                 last_transition_fingerprint is null
                 or last_transition_fingerprint ~ '^[0-9a-f]{64}$'
               )`,
          ),
        );
      }
      await asOwner(workspaceA, (client) =>
        client.query(
          'alter table app.run_events drop constraint run_events_payload_bounded',
        ),
      );
      try {
        await expect(
          checkDatabaseReadiness(readinessPool, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
          }),
        ).rejects.toThrow('Execution value persistence is incompatible');
      } finally {
        await asOwner(workspaceA, (client) =>
          client.query(
            `alter table app.run_events
               add constraint run_events_payload_bounded
               check (octet_length(payload::text) <= 524288)`,
          ),
        );
      }
      await asOwner(workspaceA, (client) =>
        client.query(
          `alter policy artifacts_workspace_scope on app.artifacts
             using (true)`,
        ),
      );
      try {
        await expect(
          checkDatabaseReadiness(readinessPool, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
          }),
        ).rejects.toThrow('Execution value persistence is incompatible');
      } finally {
        await asOwner(workspaceA, (client) =>
          client.query(
            `alter policy artifacts_workspace_scope on app.artifacts
               using (
                 workspace_id::text = nullif(
                   current_setting('app.workspace_id', true), ''
                 )
               )`,
          ),
        );
      }
      await expect(
        checkDatabaseReadiness(readinessPool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).resolves.toMatchObject({
        migrationHead: '0113_workflow_run_statistics_index.sql',
      });
    } finally {
      await readinessPool.end();
    }
    const binding = await asRuntime(apiBaseUrl, workspaceA, (client) =>
      client.query<{ matches: boolean }>(
        `select checkpoint.workflow_version_id = run.workflow_version_id as matches
           from app.run_checkpoints checkpoint
           join app.workflow_runs run on run.id=checkpoint.workflow_run_id
           where checkpoint.workflow_run_id=$1`,
        [retainedRunId],
      ),
    );
    expect(binding.rows[0]?.matches).toBe(true);
    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId: retainedRunId,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'not_executable' });

    const legacyExecutable = await insertRun({ schedulerState: {} });
    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId: legacyExecutable,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'unsupported_checkpoint' });
  });

  it('rejects provider keys outside idempotent-with-key node and attempt rows', async () => {
    const runId = await insertRun({});
    const nodeRunId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,
             branch_context,status,side_effect_class
           ) values ($1,$2,$3,'constraint-node',$4,'{}'::jsonb,'ready','safe')`,
        [nodeRunId, workspaceA, runId, `${versionA}|constraint-node|b:|i:`],
      ),
    );
    for (const [sideEffectClass, providerKey, suffix] of [
      ['safe', 'invalid', 'safe'],
      ['idempotent_with_key', null, 'idempotent'],
    ] as const)
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            `insert into app.node_runs (
                 id,workspace_id,workflow_run_id,node_id,invocation_key,
                 branch_context,status,side_effect_class,provider_idempotency_key
               ) values ($1,$2,$3,$4,$5,'{}'::jsonb,'ready',$6,$7)`,
            [
              randomUUID(),
              workspaceA,
              runId,
              `invalid-${suffix}`,
              `${versionA}|invalid-${suffix}|b:|i:`,
              sideEffectClass,
              providerKey,
            ],
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    for (const [sideEffectClass, providerKey] of [
      ['safe', 'invalid'],
      ['idempotent_with_key', null],
    ] as const) {
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            `insert into app.node_attempts (
                 id,workspace_id,node_run_id,attempt_number,status,
                 side_effect_class,provider_idempotency_key
               ) values ($1,$2,$3,1,'ready',$4,$5)`,
            [randomUUID(), workspaceA, nodeRunId, sideEffectClass, providerKey],
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });
});
