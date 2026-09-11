import type { Pool, PoolClient, QueryConfig, QueryResult } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import { OperatorCommandConflictError } from './operator-command-errors.js';
import type {
  GenericOperatorCommandResult,
  OperatorCommandDatabaseOptions,
} from './operator-command-contracts.js';
import { createDatabasePool } from '../platform/postgres-telemetry.js';
import {
  EXPECTED_MIGRATION_HEAD,
  MINIMUM_POSTGRES_MAJOR,
} from '../platform/readiness.js';

type RuntimeOptions = Readonly<{
  forbiddenRoles: readonly string[];
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}>;

type OperatorReadinessRow = Readonly<{
  postgres_major: number;
  migration_head: string | null;
  rolsuper: boolean;
  rolbypassrls: boolean;
  owner_member: boolean;
  forbidden_member: boolean;
  expected_role: boolean;
  direct_outbox: boolean;
  direct_audit: boolean;
  direct_command: boolean;
  direct_evidence: boolean;
  direct_execution: boolean;
  private_command: boolean;
  can_command: boolean;
  can_execution_commands: boolean;
  can_trigger_command: boolean;
  can_replay_command: boolean;
  can_maintenance_rerun: boolean;
  can_get: boolean;
}>;

export interface OperatorCommandRuntime {
  checkReadiness(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  execute(
    text: string,
    values: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<GenericOperatorCommandResult>;
  transaction<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<QueryResult<Row>>;
}

async function query<Row extends Record<string, unknown>>(
  pool: Pool | PoolClient,
  text: string,
  values: readonly unknown[],
  signal?: AbortSignal,
): Promise<QueryResult<Row>> {
  signal?.throwIfAborted();
  const request: QueryConfig<unknown[]> & { readonly signal?: AbortSignal } = {
    ...(signal === undefined ? {} : { signal }),
    text,
    values: [...values],
  };
  try {
    const result = await pool.query<Row>(request);
    signal?.throwIfAborted();
    return result;
  } catch (error: unknown) {
    if (signal?.aborted === true) throw signal.reason;
    throw error;
  }
}

function parseOptions(input: OperatorCommandDatabaseOptions): RuntimeOptions {
  return z
    .object({
      lockTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
      forbiddenRoles: z
        .array(z.string().regex(/^[a-z_][a-z0-9_]*$/u))
        .min(1)
        .max(16)
        .default([
          'pertexo_api',
          'pertexo_dispatcher',
          'pertexo_lifecycle_command',
          'pertexo_maintenance',
          'pertexo_migration',
          'pertexo_owner',
          'pertexo_worker',
        ]),
      statementTimeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(300_000)
        .default(30_000),
    })
    .parse(input);
}

export function createOperatorCommandRuntime(
  config: DatabaseConfig,
  operatorRole: string,
  inputOptions: OperatorCommandDatabaseOptions,
): OperatorCommandRuntime {
  const { ownerRole, workerRuntimeRole, ...poolConfig } = config;
  void workerRuntimeRole;
  const options = parseOptions(inputOptions);
  const pool = createDatabasePool({ ...poolConfig, max: 1 });
  pool.on('error', () => undefined);

  const transaction = async <Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<QueryResult<Row>> => {
    const client = await pool.connect();
    try {
      await query(client, 'begin', [], signal);
      await query(
        client,
        "select set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
        [String(options.lockTimeoutMs), String(options.statementTimeoutMs)],
        signal,
      );
      const result = await query<Row>(client, text, values, signal);
      await query(client, 'commit', [], signal);
      return result;
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  const execute = async (
    text: string,
    values: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<GenericOperatorCommandResult> => {
    const response = await transaction(text, values, signal);
    const row = response.rows[0];
    if (row === undefined)
      throw new Error('Operator command returned no result');
    if (row.command_outcome === 'conflict')
      throw new OperatorCommandConflictError();
    return Object.freeze({
      commandId: z.uuid().parse(row.command_id),
      outcome: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,31}$/u)
        .parse(row.command_outcome),
      replayed: z.boolean().parse(row.replayed),
      result: Object.freeze(
        z.record(z.string(), z.unknown()).parse(row.result),
      ),
      status: z
        .enum(['completed', 'failed', 'pending'])
        .parse(row.command_status),
    });
  };

  return Object.freeze({
    checkReadiness: (signal?: AbortSignal) =>
      checkReadiness(pool, ownerRole, operatorRole, options, signal),
    close: () => pool.end(),
    execute,
    transaction,
  });
}

async function checkReadiness(
  pool: Pool,
  ownerRole: string,
  operatorRole: string,
  options: RuntimeOptions,
  signal?: AbortSignal,
): Promise<void> {
  const row = await loadOperatorReadinessSnapshot(
    pool,
    ownerRole,
    operatorRole,
    options,
    signal,
  );
  assertOperatorReleaseSupport(row);
  assertOperatorRoleBoundary(row);
  assertNoOperatorDirectGrants(row);
  assertOperatorCapabilities(row);
}

async function loadOperatorReadinessSnapshot(
  pool: Pool,
  ownerRole: string,
  operatorRole: string,
  options: RuntimeOptions,
  signal?: AbortSignal,
): Promise<OperatorReadinessRow | undefined> {
  const client = await pool.connect();
  try {
    await query(client, 'begin', [], signal);
    await query(
      client,
      "select set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
      [String(options.lockTimeoutMs), String(options.statementTimeoutMs)],
      signal,
    );
    const response = await query<OperatorReadinessRow>(
      client,
      `select
          current_setting('server_version_num')::integer/10000 postgres_major,
          role.rolsuper,role.rolbypassrls,
          pg_has_role(current_user,$1::name,'MEMBER') owner_member,
          current_user=$2::name as expected_role,
          exists(select 1 from unnest($3::name[]) forbidden(role_name)
            where pg_has_role(current_user,forbidden.role_name,'MEMBER')) forbidden_member,
          (has_any_column_privilege(current_user,'app.outbox_events','SELECT,INSERT,UPDATE,REFERENCES')
            or has_table_privilege(current_user,'app.outbox_events','DELETE,TRUNCATE,TRIGGER')) direct_outbox,
          (has_any_column_privilege(current_user,'app.audit_events','SELECT,INSERT,UPDATE,REFERENCES')
            or has_table_privilege(current_user,'app.audit_events','DELETE,TRUNCATE,TRIGGER')) direct_audit,
          (has_any_column_privilege(current_user,'app.operator_commands','SELECT,INSERT,UPDATE,REFERENCES')
            or has_table_privilege(current_user,'app.operator_commands','DELETE,TRUNCATE,TRIGGER')) direct_command,
          (has_any_column_privilege(current_user,'app.operator_unknown_outcome_evidence','SELECT,INSERT,UPDATE,REFERENCES')
            or has_table_privilege(current_user,'app.operator_unknown_outcome_evidence','DELETE,TRUNCATE,TRIGGER')) direct_evidence,
          exists(select 1 from (values ('workflow_runs'),('run_events'),
            ('run_checkpoints'),('node_runs'),('node_attempts')) execution(table_name)
            where has_any_column_privilege(current_user,'app.'||execution.table_name,'SELECT,INSERT,UPDATE,REFERENCES')
              or has_table_privilege(current_user,'app.'||execution.table_name,'DELETE,TRUNCATE,TRIGGER')) direct_execution,
          has_function_privilege(current_user,'app.redispatch_failed_outbox_event(uuid,uuid,uuid,character varying,character varying,boolean)','EXECUTE') can_command,
          (has_function_privilege(current_user,'app.reconcile_operator_attempt(uuid,uuid,uuid,bigint,character varying,character varying,character varying,boolean)','EXECUTE')
            and has_function_privilege(current_user,'app.resume_operator_due_work(uuid,uuid,uuid,character varying,character varying,boolean)','EXECUTE')
            and has_function_privilege(current_user,'app.record_operator_unknown_outcome_evidence(uuid,uuid,uuid,character varying,jsonb,character varying,character varying)','EXECUTE')
            and has_function_privilege(current_user,'app.cancel_operator_run(uuid,uuid,uuid,character varying,character varying,boolean)','EXECUTE')) can_execution_commands,
          has_function_privilege(current_user,'app.get_operator_command(uuid,uuid,character varying,character varying)','EXECUTE') can_get,
          has_function_privilege(current_user,'app.retry_operator_trigger_reconciliation(uuid,uuid,uuid,character varying,character varying,boolean)','EXECUTE') can_trigger_command,
          has_function_privilege(current_user,'app.request_operator_run_replay(uuid,uuid,uuid,uuid,jsonb,character varying,character varying,boolean)','EXECUTE') can_replay_command,
          has_function_privilege(current_user,'app.request_operator_maintenance_rerun(uuid,uuid,character varying,uuid,character varying,character varying,boolean)','EXECUTE') can_maintenance_rerun,
          has_function_privilege(current_user,'app.execute_operator_execution_command(uuid,character varying,uuid,uuid,bigint,character varying,character varying,jsonb,character varying,character varying,boolean)','EXECUTE') private_command,
          (select name from pertexo_internal.schema_migrations order by name desc limit 1) migration_head
        from pg_roles role where role.rolname=current_user`,
      [ownerRole, operatorRole, options.forbiddenRoles],
      signal,
    );
    await query(client, 'commit', [], signal);
    return response.rows[0];
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function incompatibleOperatorBoundary(): never {
  throw new Error('Operator command database boundary is incompatible');
}

function assertOperatorReleaseSupport(
  row: OperatorReadinessRow | undefined,
): asserts row is OperatorReadinessRow {
  if (row === undefined) incompatibleOperatorBoundary();
  const postgresMajor = z.number().int().parse(row.postgres_major);
  if (
    postgresMajor < MINIMUM_POSTGRES_MAJOR ||
    row.migration_head !== EXPECTED_MIGRATION_HEAD
  )
    incompatibleOperatorBoundary();
}

function assertOperatorRoleBoundary(row: OperatorReadinessRow): void {
  if (
    row.rolsuper ||
    row.rolbypassrls ||
    row.owner_member ||
    row.forbidden_member ||
    !row.expected_role
  )
    incompatibleOperatorBoundary();
}

function assertNoOperatorDirectGrants(row: OperatorReadinessRow): void {
  if (
    row.direct_outbox ||
    row.direct_audit ||
    row.direct_command ||
    row.direct_evidence ||
    row.direct_execution ||
    row.private_command
  )
    incompatibleOperatorBoundary();
}

function assertOperatorCapabilities(row: OperatorReadinessRow): void {
  if (
    !row.can_command ||
    !row.can_execution_commands ||
    !row.can_trigger_command ||
    !row.can_replay_command ||
    !row.can_maintenance_rerun ||
    !row.can_get
  )
    incompatibleOperatorBoundary();
}
