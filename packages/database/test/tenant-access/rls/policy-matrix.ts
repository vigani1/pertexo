import type { Pool, PoolClient } from 'pg';

export const policyDrops = [
  ['artifacts', 'artifacts_owner_retention_delete'],
  ['artifacts', 'artifacts_owner_retention_update'],
  ['node_runs', 'node_runs_due_wakeup_owner_select'],
  ['outbox_events', 'outbox_events_dispatcher_select'],
  ['outbox_events', 'outbox_events_dispatcher_update'],
  [
    'trigger_schedule_occurrences',
    'trigger_schedule_occurrences_retention_scope',
  ],
  ['trigger_schedules', 'trigger_schedules_worker_reconciliation'],
  ['webhook_trigger_deliveries', 'webhook_trigger_deliveries_retention_scope'],
  ['webhook_trigger_endpoints', 'webhook_trigger_endpoints_api_scope'],
  [
    'webhook_trigger_replay_records',
    'webhook_trigger_replay_records_retention_scope',
  ],
  ['workflow_triggers', 'workflow_triggers_worker_reconciliation'],
  ['workflows', 'workflows_worker_trigger_reconciliation'],
] as const;
const tables = [...new Set(policyDrops.map(([table]) => table))];
const roles = ['pertexo_app', 'pertexo_owner', 'pertexo_maintenance'];
export const workspaces = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
];
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

interface Policy {
  tablename: string;
  policyname: string;
  permissive: string;
  roles: string[];
  cmd: string;
  qual: string | null;
  with_check: string | null;
}
export interface AccessOutcome {
  table: string;
  role: string;
  context: string;
  operation: string;
  output: number[] | { code: string | undefined };
}

export async function securityCatalog(admin: Pool) {
  return {
    tables: (
      await admin.query(
        `select relname,relrowsecurity,relforcerowsecurity,relacl::text
      from pg_class where relnamespace='app'::regnamespace and relname=any($1) order by relname`,
        [tables],
      )
    ).rows,
    columns: (
      await admin.query(
        `select table_name,column_name,grantee,privilege_type
      from information_schema.column_privileges where table_schema='app' and table_name=any($1)
      order by table_name,column_name,grantee,privilege_type`,
        [tables],
      )
    ).rows,
  };
}

/** Execute the installed policies unchanged, apart from their target relation.
 * This separates authorization from unrelated product constraints and triggers;
 * the real relations' ACLs and FORCE RLS are checked separately.
 */
export async function policyMatrix(admin: Pool): Promise<AccessOutcome[]> {
  const policies = (
    await admin.query<Policy>(
      `select tablename,policyname,permissive,roles::text[] roles,cmd,qual,with_check
    from pg_policies where schemaname='app' and tablename=any($1) order by tablename,policyname`,
      [tables],
    )
  ).rows;
  const client = await admin.connect();
  const outcomes: AccessOutcome[] = [];
  try {
    await client.query('create schema policy_matrix');
    await client.query(
      `grant usage on schema policy_matrix to ${roles.map(quote).join(',')}`,
    );
    for (const table of tables) {
      const target = `policy_matrix.${quote(table)}`;
      await client.query(
        `create table ${target}(id int,workspace_id uuid,job_name text,published_at timestamptz,failed_at timestamptz)`,
      );
      await client.query(`alter table ${target} owner to pertexo_owner`);
      await client.query(
        `grant select,insert,update,delete on ${target} to ${roles.map(quote).join(',')}`,
      );
      await client.query(`alter table ${target} enable row level security`);
      await client.query(`alter table ${target} force row level security`);
      for (const policy of policies.filter((p) => p.tablename === table)) {
        await client.query(`create policy ${quote(policy.policyname)} on ${target} as ${policy.permissive}
          for ${policy.cmd} to ${policy.roles.map(quote).join(',')}
          ${policy.qual === null ? '' : `using (${policy.qual})`}
          ${policy.with_check === null ? '' : `with check (${policy.with_check})`}`);
      }
      await populatePolicyRows(client, target);
      const contexts = roles.flatMap((role) =>
        ['', ...workspaces].map((context) => ({ role, context })),
      );
      for (const { role, context } of contexts) {
        for (const [operation, statement] of policyOperations(target)) {
          const output = await executePolicyOperation(
            client,
            role,
            context,
            statement,
          );
          outcomes.push({ table, role, context, operation, output });
        }
      }
      await client.query(`drop table ${target}`);
    }
    return outcomes;
  } finally {
    await client.query('drop schema if exists policy_matrix cascade');
    client.release();
  }
}

async function populatePolicyRows(
  client: PoolClient,
  target: string,
): Promise<void> {
  const rows = workspaces.flatMap((workspace) =>
    [
      'start-error-workflow',
      'apply-connection-health-observation',
      'other',
    ].flatMap((job) =>
      [null, '2026-01-01'].flatMap((published) =>
        [null, '2026-01-01'].map((failed) => [
          workspace,
          job,
          published,
          failed,
        ]),
      ),
    ),
  );
  for (const [index, row] of rows.entries())
    await client.query(`insert into ${target} values($1,$2,$3,$4,$5)`, [
      index + 1,
      ...row,
    ]);
}

function policyOperations(target: string): [string, string][] {
  const operations: [string, string][] = [
    ['select', `select id from ${target} order by id`],
    ['update', `update ${target} set id=id returning id`],
    ['delete', `delete from ${target} returning id`],
  ];
  for (const workspace of workspaces) {
    operations.push([
      'move-' + workspace,
      `update ${target} set workspace_id='${workspace}' returning id`,
    ]);
    for (const job of ['start-error-workflow', 'other'])
      operations.push([
        'insert-' + workspace + '-' + job,
        `insert into ${target}(id,workspace_id,job_name) values(100,'${workspace}','${job}') returning id`,
      ]);
  }
  return operations;
}

async function executePolicyOperation(
  client: PoolClient,
  role: string,
  context: string,
  statement: string,
): Promise<AccessOutcome['output']> {
  await client.query('begin');
  try {
    await client.query(`set local role ${quote(role)}`);
    await client.query("select set_config('app.workspace_id',$1,true)", [
      context,
    ]);
    return (await client.query<{ id: number }>(statement)).rows
      .map((row) => row.id)
      .sort((a, b) => a - b);
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error)) throw error;
    return { code: String(error.code) };
  } finally {
    await client.query('rollback');
  }
}
