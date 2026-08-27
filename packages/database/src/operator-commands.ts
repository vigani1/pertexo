import { Pool, type PoolClient, type QueryConfig, type QueryResult } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from './config.js';
import {
  EXPECTED_MIGRATION_HEAD,
  MINIMUM_POSTGRES_MAJOR,
} from './readiness.js';

const actorRefSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u);
const reasonSchema = z.string().min(1).max(512);
const redispatchInputSchema = z
  .object({
    actorRef: actorRefSchema,
    commandId: z.uuid(),
    dryRun: z.boolean(),
    outboxEventId: z.uuid(),
    reason: reasonSchema,
    signal: z
      .custom<AbortSignal>((value) => value instanceof AbortSignal)
      .optional(),
    workspaceId: z.uuid(),
  })
  .strict();

export type RedispatchFailedOutboxInput = Readonly<
  z.input<typeof redispatchInputSchema>
>;
export type OperatorCommandOutcome =
  | 'already_published'
  | 'not_failed'
  | 'not_found'
  | 'redispatched'
  | 'would_redispatch';
export type OperatorCommandResult = Readonly<{
  commandId: string;
  outcome: OperatorCommandOutcome;
  replayed: boolean;
  status: 'completed';
}>;
export type OperatorCommandRecord = Readonly<{
  commandId: string;
  commandType: OperatorCommandType;
  completedAt: Date;
  createdAt: Date;
  dryRun: boolean;
  outcome: string;
  priorErrorCode: string | null;
  priorFailedAt: Date | null;
  priorPublishAttempts: number | null;
  result: Readonly<Record<string, unknown>>;
  requestFingerprint: string;
  status: 'completed';
}>;
export type OperatorCommandType =
  | 'attempt.reconcile'
  | 'due-work.resume'
  | 'outbox.redispatch'
  | 'purge.rerun'
  | 'retention.rerun'
  | 'run.cancel'
  | 'run.replay'
  | 'trigger.reconcile'
  | 'unknown-outcome.record-evidence';
export type GetOperatorCommandInput = Readonly<{
  actorRef: string;
  commandId: string;
  reason: string;
  signal?: AbortSignal;
  workspaceId: string;
}>;

export interface OperatorCommandDatabase {
  checkReadiness(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  getCommand(
    input: GetOperatorCommandInput,
  ): Promise<OperatorCommandRecord | null>;
  redispatchFailedOutbox(
    input: RedispatchFailedOutboxInput,
  ): Promise<OperatorCommandResult>;
}

export interface OperatorCommandDatabaseOptions {
  readonly forbiddenRoles?: readonly string[];
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}

const outcomeSchema = z.enum([
  'already_published',
  'not_failed',
  'not_found',
  'redispatched',
  'would_redispatch',
]);
const commandTypeSchema = z.enum([
  'attempt.reconcile',
  'due-work.resume',
  'outbox.redispatch',
  'purge.rerun',
  'retention.rerun',
  'run.cancel',
  'run.replay',
  'trigger.reconcile',
  'unknown-outcome.record-evidence',
]);

export class OperatorCommandConflictError extends Error {
  public constructor() {
    super('Operator command replay conflicts with the existing request');
    this.name = 'OperatorCommandConflictError';
  }
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

export function createOperatorCommandDatabase(
  config: DatabaseConfig,
  operatorRole = 'pertexo_operator',
  inputOptions: OperatorCommandDatabaseOptions = {},
): OperatorCommandDatabase {
  const { ownerRole, workerRuntimeRole, ...poolConfig } = config;
  void workerRuntimeRole;
  const options = z
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
    .parse(inputOptions);
  const pool = new Pool({ ...poolConfig, max: 1 });
  pool.on('error', () => undefined);

  return Object.freeze({
    checkReadiness: async (signal?: AbortSignal): Promise<void> => {
      const client = await pool.connect();
      try {
        await query(client, 'begin', [], signal);
        await query(
          client,
          "select set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
          [String(options.lockTimeoutMs), String(options.statementTimeoutMs)],
          signal,
        );
        const result = await query<{
          can_command: boolean;
          can_get: boolean;
          direct_audit: boolean;
          direct_command: boolean;
          direct_outbox: boolean;
          expected_role: boolean;
          forbidden_member: boolean;
          migration_head: string | null;
          owner_member: boolean;
          postgres_major: number;
          rolbypassrls: boolean;
          rolsuper: boolean;
        }>(
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
          has_function_privilege(current_user,'app.redispatch_failed_outbox_event(uuid,uuid,uuid,character varying,character varying,boolean)','EXECUTE') can_command,
          has_function_privilege(current_user,'app.get_operator_command(uuid,uuid,character varying,character varying)','EXECUTE') can_get,
          (select name from pertexo_internal.schema_migrations order by name desc limit 1) migration_head
        from pg_roles role where role.rolname=current_user`,
          [ownerRole, operatorRole, options.forbiddenRoles],
          signal,
        );
        await query(client, 'commit', [], signal);
        const row = result.rows[0];
        if (
          row === undefined ||
          row.postgres_major < MINIMUM_POSTGRES_MAJOR ||
          row.migration_head !== EXPECTED_MIGRATION_HEAD ||
          row.rolsuper ||
          row.rolbypassrls ||
          row.owner_member ||
          row.forbidden_member ||
          !row.expected_role ||
          row.direct_outbox ||
          row.direct_audit ||
          row.direct_command ||
          !row.can_command ||
          !row.can_get
        ) {
          throw new Error('Operator command database boundary is incompatible');
        }
      } catch (error: unknown) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
    getCommand: async (
      input: GetOperatorCommandInput,
    ): Promise<OperatorCommandRecord | null> => {
      const parsed = z
        .object({
          actorRef: actorRefSchema,
          commandId: z.uuid(),
          reason: reasonSchema,
          signal: z
            .custom<AbortSignal>((value) => value instanceof AbortSignal)
            .optional(),
          workspaceId: z.uuid(),
        })
        .strict()
        .parse(input);
      const client = await pool.connect();
      try {
        await query(client, 'begin', [], parsed.signal);
        await query(
          client,
          "select set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
          [String(options.lockTimeoutMs), String(options.statementTimeoutMs)],
          parsed.signal,
        );
        const result = await query(
          client,
          `select * from app.get_operator_command(
            $1::uuid,$2::uuid,$3::varchar,$4::varchar)`,
          [
            parsed.commandId,
            parsed.workspaceId,
            parsed.actorRef,
            parsed.reason,
          ],
          parsed.signal,
        );
        await query(client, 'commit', [], parsed.signal);
        const row = result.rows[0];
        if (row === undefined) return null;
        const commandResult = z
          .record(z.string(), z.unknown())
          .parse(row.result);
        return Object.freeze({
          commandId: z.uuid().parse(row.command_id),
          commandType: commandTypeSchema.parse(row.command_type),
          completedAt: new Date(
            z.union([z.string(), z.date()]).parse(row.completed_at),
          ),
          createdAt: new Date(
            z.union([z.string(), z.date()]).parse(row.created_at),
          ),
          dryRun: z.boolean().parse(row.dry_run),
          outcome: z
            .string()
            .regex(/^[a-z][a-z0-9_]{0,31}$/u)
            .parse(row.command_outcome),
          priorErrorCode: z
            .string()
            .nullable()
            .parse(commandResult.priorErrorCode ?? null),
          priorFailedAt:
            commandResult.priorFailedAt == null
              ? null
              : new Date(
                  z
                    .union([z.string(), z.date()])
                    .parse(commandResult.priorFailedAt),
                ),
          priorPublishAttempts: z.coerce
            .number()
            .int()
            .nonnegative()
            .nullable()
            .parse(commandResult.priorPublishAttempts ?? null),
          result: Object.freeze(commandResult),
          requestFingerprint: z
            .string()
            .regex(/^[0-9a-f]{64}$/u)
            .parse(row.request_fingerprint),
          status: z.literal('completed').parse(row.command_status),
        });
      } catch (error: unknown) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    redispatchFailedOutbox: async (
      input: RedispatchFailedOutboxInput,
    ): Promise<OperatorCommandResult> => {
      const parsed = redispatchInputSchema.parse(input);
      const client = await pool.connect();
      try {
        await query(client, 'begin', [], parsed.signal);
        await query(
          client,
          "select set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
          [String(options.lockTimeoutMs), String(options.statementTimeoutMs)],
          parsed.signal,
        );
        const result = await query(
          client,
          `select * from app.redispatch_failed_outbox_event(
            $1::uuid,$2::uuid,$3::uuid,$4::varchar,$5::varchar,$6::boolean)`,
          [
            parsed.commandId,
            parsed.workspaceId,
            parsed.outboxEventId,
            parsed.actorRef,
            parsed.reason,
            parsed.dryRun,
          ],
          parsed.signal,
        );
        await query(client, 'commit', [], parsed.signal);
        const row = result.rows[0];
        if (row === undefined)
          throw new Error('Operator command returned no result');
        if (row.command_outcome === 'conflict')
          throw new OperatorCommandConflictError();
        return Object.freeze({
          commandId: z.uuid().parse(row.command_id),
          outcome: outcomeSchema.parse(row.command_outcome),
          replayed: z.boolean().parse(row.replayed),
          status: z.literal('completed').parse(row.command_status),
        });
      } catch (error: unknown) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  });
}
