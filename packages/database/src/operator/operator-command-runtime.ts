import type { Pool, PoolClient, QueryConfig, QueryResult } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import { OperatorCommandConflictError } from './operator-command-errors.js';
import type {
  GenericOperatorCommandResult,
  OperatorCommandDatabaseOptions,
} from './operator-commands.js';
import { createDatabasePool } from '../postgres-telemetry.js';
import {
  EXPECTED_MIGRATION_HEAD,
  MINIMUM_POSTGRES_MAJOR,
} from '../readiness.js';

type RuntimeOptions = Readonly<{
  forbiddenRoles: readonly string[];
  lockTimeoutMs: number;
  statementTimeoutMs: number;
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
  const result = await (async () => {
    const client = await pool.connect();
    try {
      await query(client, 'begin', [], signal);
      await query(
        client,
        "select set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
        [String(options.lockTimeoutMs), String(options.statementTimeoutMs)],
        signal,
      );
      const response = await query<Record<string, unknown>>(
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
      return response;
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  })();
  const row = result.rows[0];
  if (
    row === undefined ||
    z.number().int().parse(row.postgres_major) < MINIMUM_POSTGRES_MAJOR ||
    row.migration_head !== EXPECTED_MIGRATION_HEAD ||
    row.rolsuper === true ||
    row.rolbypassrls === true ||
    row.owner_member === true ||
    row.forbidden_member === true ||
    row.expected_role !== true ||
    row.direct_outbox === true ||
    row.direct_audit === true ||
    row.direct_command === true ||
    row.direct_evidence === true ||
    row.direct_execution === true ||
    row.private_command === true ||
    row.can_command !== true ||
    row.can_execution_commands !== true ||
    row.can_trigger_command !== true ||
    row.can_replay_command !== true ||
    row.can_maintenance_rerun !== true ||
    row.can_get !== true
  )
    throw new Error('Operator command database boundary is incompatible');
}
