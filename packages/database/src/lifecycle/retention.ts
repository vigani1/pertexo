import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';
import type { Pool } from 'pg';
import type { PoolClient, QueryResult } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import type { ControlLedger } from './control-ledger-coordinator.js';
import { inRetentionTransaction } from './retention-transaction.js';
import { EXPECTED_MIGRATION_HEAD } from '../platform/readiness.js';
import {
  reapTransientData,
  type TransientDataReapResult,
} from './transient-data-retention.js';

const uuidSchema = z.uuid();
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const dateSchema = z.date().refine((value) => Number.isFinite(value.getTime()));
const retentionKindSchema = z.enum([
  'workflow_run_input',
  'execution_detail',
  'run_summary',
  'trigger_summary',
  'audit_security',
]);
export type RetentionKind = z.infer<typeof retentionKindSchema>;

export interface StartWorkflowRunInputRetentionDryRunInput {
  readonly batchId: string;
  readonly cutoffAt: Date;
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly retentionKind?: RetentionKind;
  readonly signal?: AbortSignal;
  readonly workspaceId: string;
}

export type StartWorkflowRunInputRetentionInput =
  StartWorkflowRunInputRetentionDryRunInput;

export interface RetentionDryRunClaim {
  readonly batchId: string;
  readonly cutoffAt: Date;
  readonly cursorExpiresAt: Date | null;
  readonly cursorId: string | null;
  readonly dryRunCursor: RetentionDryRunTuple | null;
  readonly dryRunUpper: RetentionDryRunTuple | null;
  readonly leaseExpiresAt: Date;
  readonly leaseFence: number;
  readonly leaseToken: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly retentionKind: RetentionKind;
  readonly workspaceId: string;
}

export interface RetentionDryRunPageResult {
  readonly completed: boolean;
  readonly cursorExpiresAt: Date | null;
  readonly cursorId: string | null;
  readonly eligibleDelta: number;
  readonly examinedDelta: number;
  readonly outcome: 'completed' | 'progressed' | 'stale';
  readonly stale: boolean;
}

export type RetentionDryRunTuple = Readonly<{
  type: 'timestamp_uuid' | 'timestamp_uuid_text_text' | 'uuid' | 'uuid_bigint';
  values: readonly (number | string)[];
}>;

export type RetentionDryRunProcessResult =
  | Readonly<{ status: 'idle' }>
  | Readonly<{
      batchId: string;
      eligibleCount: number;
      examinedCount: number;
      pageCount: number;
      retentionKind: RetentionKind;
      status: 'completed' | 'stale';
      workspaceId: string;
    }>;

export interface RetentionDatabaseOptions {
  readonly leaseOwner: string;
  readonly leaseSeconds?: number;
  readonly maxPagesPerBatch?: number;
  readonly pageSize?: number;
}

export interface RetentionScheduleResult {
  readonly cutoffAt: Date;
  readonly scannedCount: number;
  readonly scheduledCount: number;
}

export type RegionalReplicaLagObservation = Readonly<{
  replayLagMillis: number | null;
  replicationState: string;
  status: 'open' | 'paused' | 'unavailable';
}>;

export interface RetentionDatabase {
  checkReadiness(input: {
    readonly expectedMaintenanceRole: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  claimDryRuns(signal?: AbortSignal): Promise<readonly RetentionDryRunClaim[]>;
  close(): Promise<void>;
  executeDryRunPage(
    claim: RetentionDryRunClaim,
    signal?: AbortSignal,
  ): Promise<RetentionDryRunPageResult>;
  processNext(signal?: AbortSignal): Promise<RetentionDryRunProcessResult>;
  processOperatorRerun(
    signal?: AbortSignal,
  ): Promise<OperatorMaintenanceRerunResult | null>;
  recordRegionalReplicaLag(
    applicationName: string,
    signal?: AbortSignal,
  ): Promise<RegionalReplicaLagObservation>;
  reapTransientData(signal?: AbortSignal): Promise<TransientDataReapResult>;
  scheduleEnforcement(signal?: AbortSignal): Promise<RetentionScheduleResult>;
  startDryRun(
    input: StartWorkflowRunInputRetentionDryRunInput,
  ): Promise<string>;
  startEnforcement(input: StartWorkflowRunInputRetentionInput): Promise<string>;
}

export type OperatorMaintenanceRerunResult = Readonly<{
  commandId: string;
  outcome: string;
  targetId: string;
  targetType: 'retention_batch' | 'workspace_purge_job';
  workspaceId: string;
}>;

export type RetentionEnforcementProcessResult =
  | Readonly<{ status: 'idle' }>
  | Readonly<{
      batchId: string;
      eligibleCount: number;
      examinedCount: number;
      pageCount: number;
      retentionKind: RetentionKind;
      status: 'completed' | 'paused' | 'released' | 'stale';
      workspaceId: string;
    }>;

export interface RetentionEnforcementCoordinator {
  close(): Promise<void>;
  processNext(signal?: AbortSignal): Promise<RetentionEnforcementProcessResult>;
}

export interface RetentionEnforcementCoordinatorOptions extends RetentionDatabaseOptions {
  readonly externalOperationTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}

const optionsSchema = z
  .object({
    leaseOwner: boundedText(128),
    leaseSeconds: z.number().int().min(1).max(300).default(300),
    maxPagesPerBatch: z.number().int().min(1).max(10_000).default(1_000),
    pageSize: z.number().int().min(1).max(1_000).default(100),
  })
  .strict();

function query<Row extends Record<string, unknown>>(
  pool: Pool | PoolClient,
  text: string,
  values: readonly unknown[],
  signal?: AbortSignal,
): Promise<QueryResult<Row>> {
  signal?.throwIfAborted();
  return pool.query<Row>({
    text,
    values: [...values],
    ...(signal === undefined ? {} : { signal }),
  });
}

function mapClaim(row: Record<string, unknown>): RetentionDryRunClaim {
  return Object.freeze({
    batchId: uuidSchema.parse(row.batch_id),
    workspaceId: uuidSchema.parse(row.workspace_id),
    retentionKind: retentionKindSchema.parse(row.retention_kind),
    cutoffAt: z.coerce.date().parse(row.cutoff_at),
    requestedBy: boundedText(128).parse(row.requested_by),
    reason: boundedText(512).parse(row.reason),
    cursorExpiresAt:
      row.cursor_expires_at === null
        ? null
        : z.coerce.date().parse(row.cursor_expires_at),
    cursorId: row.cursor_id === null ? null : uuidSchema.parse(row.cursor_id),
    dryRunCursor:
      row.dry_run_cursor === null || row.dry_run_cursor === undefined
        ? null
        : retentionTupleSchema.parse(row.dry_run_cursor),
    dryRunUpper:
      row.dry_run_upper === null || row.dry_run_upper === undefined
        ? null
        : retentionTupleSchema.parse(row.dry_run_upper),
    leaseToken: uuidSchema.parse(row.lease_token),
    leaseFence: z.coerce.number().int().positive().parse(row.lease_fence),
    leaseExpiresAt: z.coerce.date().parse(row.lease_expires_at),
  });
}

const retentionTupleSchema = z
  .object({
    type: z.enum([
      'timestamp_uuid',
      'timestamp_uuid_text_text',
      'uuid',
      'uuid_bigint',
    ]),
    values: z.array(z.union([z.string(), z.number()])),
  })
  .strict();

export function createRetentionDatabase(
  config: DatabaseConfig,
  inputOptions: RetentionDatabaseOptions,
  runtime?: DatabaseRuntime,
): RetentionDatabase {
  const options = optionsSchema.parse(inputOptions);
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;

  const claim = async (signal?: AbortSignal) => {
    const result = await query(
      pool,
      'select * from app.claim_retention_dry_run_batches($1,$2,$3)',
      [options.leaseOwner, 1, options.leaseSeconds],
      signal,
    );
    return result.rows.map(mapClaim);
  };

  const executeDryRunPage = async (
    claimed: RetentionDryRunClaim,
    signal?: AbortSignal,
  ): Promise<RetentionDryRunPageResult> => {
    const standard = claimed.retentionKind !== 'workflow_run_input';
    const result = await query(
      pool,
      standard
        ? `select * from app.execute_standard_retention_dry_run_page(
          $1::uuid,$2::uuid,$3::bigint,$4::integer)`
        : `select * from app.execute_workflow_run_input_retention_dry_run_page(
        $1::uuid,$2::uuid,$3::bigint,$4::integer)`,
      [
        claimed.batchId,
        claimed.leaseToken,
        claimed.leaseFence,
        options.pageSize,
      ],
      signal,
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new Error('Retention dry-run page was not returned');
    const examinedDelta = z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(row.examined_delta);
    const eligibleDelta = z.coerce
      .number()
      .int()
      .nonnegative()
      .max(examinedDelta)
      .parse(row.eligible_delta);
    const outcome = standard
      ? z.enum(['completed', 'progressed', 'stale']).parse(row.outcome)
      : z.boolean().parse(row.completed)
        ? 'completed'
        : examinedDelta === 0 &&
            eligibleDelta === 0 &&
            row.cursor_expires_at === null &&
            row.cursor_id === null
          ? 'stale'
          : 'progressed';
    const completed = outcome === 'completed';
    const cursorExpiresAt =
      row.cursor_expires_at === null || row.cursor_expires_at === undefined
        ? null
        : z.coerce.date().parse(row.cursor_expires_at);
    const cursorId =
      row.cursor_id === null || row.cursor_id === undefined
        ? null
        : uuidSchema.parse(row.cursor_id);
    return Object.freeze({
      completed,
      cursorExpiresAt,
      cursorId,
      eligibleDelta,
      examinedDelta,
      outcome,
      stale: outcome === 'stale',
    });
  };

  const startBatch = async (
    input: StartWorkflowRunInputRetentionInput,
    dryRun: boolean,
  ) => {
    const parsed = z
      .object({
        batchId: uuidSchema,
        cutoffAt: dateSchema,
        idempotencyKey: boundedText(128),
        reason: boundedText(512),
        requestedBy: boundedText(128),
        retentionKind: retentionKindSchema.default('workflow_run_input'),
        signal: z
          .custom<AbortSignal>((value) => value instanceof AbortSignal)
          .optional(),
        workspaceId: uuidSchema,
      })
      .strict()
      .parse(input);
    const result = await query<{ batch_id: string }>(
      pool,
      `select app.start_retention_batch(
        $1::uuid,$2::uuid,$3::varchar,$4::varchar,
        $5::timestamptz,$6::boolean,$7::varchar,$8::varchar) batch_id`,
      [
        parsed.batchId,
        parsed.workspaceId,
        parsed.idempotencyKey,
        parsed.retentionKind,
        parsed.cutoffAt,
        dryRun,
        parsed.requestedBy,
        parsed.reason,
      ],
      parsed.signal,
    );
    return uuidSchema.parse(result.rows[0]?.batch_id);
  };

  const database: RetentionDatabase = {
    checkReadiness: async ({
      expectedMaintenanceRole,
      signal,
    }: {
      expectedMaintenanceRole: string;
      signal?: AbortSignal;
    }) => {
      const role = z
        .string()
        .regex(/^[a-z_][a-z0-9_]*$/u)
        .parse(expectedMaintenanceRole);
      const result = await query<{
        compatible: boolean;
        current_user: string;
        migration_head: string | null;
      }>(
        pool,
        `select current_user,
          (select name from pertexo_internal.schema_migrations order by name desc limit 1) migration_head,
          current_user=$1
            and not (select rolsuper or rolbypassrls from pg_roles where rolname=current_user)
            and pg_has_role(current_user,'pg_monitor','member')
            and has_function_privilege(current_user,
              'app.record_regional_replica_lag(character varying,character varying,bigint,integer)','EXECUTE')
            and has_function_privilege(current_user,
              'app.process_operator_maintenance_rerun()','EXECUTE')
            and has_function_privilege(current_user,
              'app.reap_transient_data(integer)','EXECUTE')
            and has_function_privilege(current_user,
              'app.start_retention_batch(uuid,uuid,character varying,character varying,timestamp with time zone,boolean,character varying,character varying)','EXECUTE')
            and has_function_privilege(current_user,
              'app.claim_retention_dry_run_batches(character varying,integer,integer)','EXECUTE')
            and has_function_privilege(current_user,
              'app.execute_workflow_run_input_retention_dry_run_page(uuid,uuid,bigint,integer)','EXECUTE')
            and has_function_privilege(current_user,
              'app.execute_standard_retention_dry_run_page(uuid,uuid,bigint,integer)','EXECUTE')
            and has_function_privilege(current_user,
              'app.claim_retention_destructive_batches(character varying,integer,integer)','EXECUTE')
            and has_function_privilege(current_user,
              'app.release_retention_batch(uuid,uuid,bigint)','EXECUTE')
            and has_function_privilege(current_user,
              'app.execute_workflow_run_input_retention_page(uuid,uuid,bigint,integer,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,
              'app.find_due_preview_cleanup(integer)','EXECUTE')
            and has_function_privilege(current_user,
              'app.prepare_preview_cleanup_step(uuid,uuid,integer,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,
              'app.complete_preview_artifact_cleanup(uuid,uuid,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,
              'app.finish_preview_cleanup(uuid,uuid,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,
              'app.schedule_workflow_run_input_retention(integer)','EXECUTE')
            and has_function_privilege(current_user,
              'app.execute_standard_retention_page(uuid,uuid,bigint,integer,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,
              'app.find_due_run_artifact_retention(integer)','EXECUTE')
            and has_function_privilege(current_user,
              'app.prepare_run_artifact_retention(uuid,uuid,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,
              'app.complete_run_artifact_retention(uuid,uuid,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,
              'app.defer_run_artifact_retention(uuid,uuid,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,
              'app.find_due_workspace_purge()','EXECUTE')
            and has_function_privilege(current_user,
              'app.workspace_purge_repair_command_id(uuid)','EXECUTE')
            and has_function_privilege(current_user,
              'app.prepare_workspace_purge_job(uuid,bigint,character,character varying,interval)','EXECUTE')
            and has_function_privilege(current_user,
              'app.release_workspace_purge_job(uuid,uuid,bigint)','EXECUTE')
            and has_function_privilege(current_user,
              'app.project_workspace_purge_started(uuid,uuid,bigint,bigint,character,character)','EXECUTE')
              and has_function_privilege(current_user,
                'app.claim_workspace_purge_step(uuid,bigint,character,character varying,interval)','EXECUTE')
              and has_function_privilege(current_user,
                'app.release_workspace_purge_step(uuid,uuid,bigint)','EXECUTE')
            and has_function_privilege(current_user,
              'app.find_due_workspace_purge_step()','EXECUTE')
            and has_function_privilege(current_user,
              'app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,
              'app.checkpoint_workspace_object_versions_page(uuid,uuid,bigint,integer,boolean,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,
              'app.find_due_workspace_purge_completion()','EXECUTE')
            and has_function_privilege(current_user,
              'app.prepare_workspace_purge_completion(uuid,bigint,character,character varying,interval)','EXECUTE')
            and has_function_privilege(current_user,
              'app.authorize_workspace_purge_completion_append(uuid,uuid,bigint,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,
              'app.project_workspace_purge_completion(uuid,uuid,bigint,bigint,character,character)','EXECUTE')
            and not has_function_privilege(current_user,
              'app.claim_retention_batches(character varying,integer,integer)','EXECUTE')
            and not has_function_privilege(current_user,
              'app.checkpoint_retention_batch(uuid,uuid,bigint,timestamp with time zone,uuid,integer,integer,boolean)','EXECUTE')
            and not has_table_privilege(current_user,'app.workflow_runs','SELECT,INSERT,UPDATE,DELETE')
            and not has_table_privilege(current_user,'app.retention_schedule_state','SELECT,INSERT,UPDATE,DELETE')
            as compatible`,
        [role],
        signal,
      );
      const row = result.rows[0];
      if (
        row?.compatible !== true ||
        row.current_user !== role ||
        row.migration_head !== EXPECTED_MIGRATION_HEAD
      ) {
        throw new Error('Retention database authority is not ready');
      }
    },
    recordRegionalReplicaLag: async (
      applicationName: string,
      signal?: AbortSignal,
    ): Promise<RegionalReplicaLagObservation> => {
      const expectedApplicationName = boundedText(128).parse(applicationName);
      const observation = await query<{
        replay_lag_millis: string | null;
        replication_state: string;
        session_count: number;
      }>(
        pool,
        `select count(*)::integer session_count,
          case when count(*)=1 then max(replica.state) else 'unavailable' end replication_state,
          case when count(*)=1 then max(
            case
              when replica.replay_lsn=pg_current_wal_lsn() then 0
              when replica.replay_lag is null then null
              else ceil(extract(epoch from replica.replay_lag)*1000)::bigint
            end
          ) else null end replay_lag_millis
        from pg_stat_replication replica
        where replica.application_name=$1`,
        [expectedApplicationName],
        signal,
      );
      const row = observation.rows[0];
      if (row === undefined)
        throw new Error('Regional replica observation was not returned');
      const replayLagMillis =
        row.replay_lag_millis === null
          ? null
          : z.coerce.number().int().nonnegative().parse(row.replay_lag_millis);
      const recorded = await query<{ status: string }>(
        pool,
        'select app.record_regional_replica_lag($1,$2,$3,$4) status',
        [
          expectedApplicationName,
          row.replication_state,
          replayLagMillis,
          z.number().int().nonnegative().parse(row.session_count),
        ],
        signal,
      );
      return Object.freeze({
        replayLagMillis,
        replicationState: boundedText(32).parse(row.replication_state),
        status: z
          .enum(['open', 'paused', 'unavailable'])
          .parse(recorded.rows[0]?.status),
      });
    },
    claimDryRuns: claim,
    close: () => lease.close(),
    executeDryRunPage,
    processOperatorRerun: async (signal?: AbortSignal) => {
      const result = await query(
        pool,
        'select * from app.process_operator_maintenance_rerun()',
        [],
        signal,
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return Object.freeze({
        commandId: uuidSchema.parse(row.command_id),
        outcome: z
          .string()
          .regex(/^[a-z][a-z0-9_]{0,31}$/u)
          .parse(row.outcome),
        targetId: uuidSchema.parse(row.target_id),
        targetType: z
          .enum(['retention_batch', 'workspace_purge_job'])
          .parse(row.target_type),
        workspaceId: uuidSchema.parse(row.workspace_id),
      });
    },
    reapTransientData: (signal?: AbortSignal) =>
      reapTransientData(pool, options.pageSize, signal),
    processNext: async (signal?: AbortSignal) => {
      const claimed = (await claim(signal))[0];
      if (claimed === undefined) return { status: 'idle' as const };
      let eligibleCount = 0;
      let examinedCount = 0;
      for (
        let pageCount = 1;
        pageCount <= options.maxPagesPerBatch;
        pageCount++
      ) {
        signal?.throwIfAborted();
        const page = await executeDryRunPage(claimed, signal);
        eligibleCount += page.eligibleDelta;
        examinedCount += page.examinedDelta;
        if (page.completed || page.stale) {
          return Object.freeze({
            batchId: claimed.batchId,
            eligibleCount,
            examinedCount,
            pageCount,
            retentionKind: claimed.retentionKind,
            status: page.completed ? 'completed' : 'stale',
            workspaceId: claimed.workspaceId,
          });
        }
      }
      throw new Error('Retention dry-run page bound exceeded');
    },
    scheduleEnforcement: async (signal?: AbortSignal) => {
      const result = await query<{
        cutoff_at: Date | string;
        scanned_count: number | string;
        scheduled_count: number | string;
      }>(
        pool,
        'select * from app.schedule_workflow_run_input_retention(25)',
        [],
        signal,
      );
      const row = result.rows[0];
      if (row === undefined)
        throw new Error('Retention schedule result was not returned');
      return Object.freeze({
        cutoffAt: z.coerce.date().parse(row.cutoff_at),
        scannedCount: z.coerce
          .number()
          .int()
          .min(0)
          .max(25)
          .parse(row.scanned_count),
        scheduledCount: z.coerce
          .number()
          .int()
          .min(0)
          .max(25)
          .parse(row.scheduled_count),
      });
    },
    startDryRun: (input) => startBatch(input, true),
    startEnforcement: (input) => startBatch(input, false),
  };
  return Object.freeze(database);
}

const enforcementOptionsSchema = optionsSchema.extend({
  externalOperationTimeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(30_000),
  lockTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
  statementTimeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
});

export function createRetentionEnforcementCoordinator(
  config: DatabaseConfig,
  ledger: ControlLedger,
  inputOptions: RetentionEnforcementCoordinatorOptions,
  runtime?: DatabaseRuntime,
): RetentionEnforcementCoordinator {
  const options = enforcementOptionsSchema.parse(inputOptions);
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;

  const claim = async (signal?: AbortSignal) => {
    const result = await query(
      pool,
      'select * from app.claim_retention_destructive_batches($1,1,$2)',
      [options.leaseOwner, options.leaseSeconds],
      signal,
    );
    return result.rows.map(mapClaim)[0];
  };

  const release = async (
    claimed: RetentionDryRunClaim,
    signal?: AbortSignal,
  ): Promise<void> => {
    await query(
      pool,
      'select app.release_retention_batch($1,$2,$3)',
      [claimed.batchId, claimed.leaseToken, claimed.leaseFence],
      signal,
    );
  };

  return Object.freeze({
    close: () => lease.close(),
    processNext: async (signal?: AbortSignal) => {
      const claimed = await claim(signal);
      if (claimed === undefined) return { status: 'idle' as const };
      let examinedCount = 0;
      let eligibleCount = 0;
      for (
        let pageCount = 1;
        pageCount <= options.maxPagesPerBatch;
        pageCount += 1
      ) {
        try {
          const highWater = await inRetentionTransaction(
            pool,
            options,
            signal,
            async (client) => {
              const lock = await query<{
                retention_control_hash: string;
                retention_control_sequence: string | number;
              }>(
                client,
                'select * from app.lock_workspace_control_ledger($1)',
                [claimed.workspaceId],
                signal,
              );
              const row = lock.rows[0];
              if (row === undefined)
                throw new Error(
                  'Retention workspace control lock was not returned',
                );
              return Object.freeze({
                hash: z
                  .string()
                  .regex(/^[0-9a-f]{64}$/u)
                  .parse(row.retention_control_hash),
                sequence: z.coerce
                  .number()
                  .int()
                  .nonnegative()
                  .parse(row.retention_control_sequence),
              });
            },
          );
          const timeoutSignal = AbortSignal.timeout(
            options.externalOperationTimeoutMs,
          );
          const externalSignal =
            signal === undefined
              ? timeoutSignal
              : AbortSignal.any([signal, timeoutSignal]);
          const reconciliation = await ledger.reconcile({
            maxRecords: 1,
            projectedHash: highWater.hash,
            projectedSequence: highWater.sequence,
            signal: externalSignal,
            workspaceId: claimed.workspaceId,
          });
          if (
            !reconciliation.reachedHighWater ||
            reconciliation.hasMore ||
            reconciliation.records.length !== 0 ||
            reconciliation.pageEndSequence !== highWater.sequence ||
            reconciliation.pageEndHash !== highWater.hash
          ) {
            throw new Error(
              'Retention control ledger is not exactly projected',
            );
          }
          const row = await inRetentionTransaction(
            pool,
            options,
            signal,
            async (client) => {
              const lock = await query<{
                retention_control_hash: string;
                retention_control_sequence: string | number;
              }>(
                client,
                'select * from app.lock_workspace_control_ledger($1)',
                [claimed.workspaceId],
                signal,
              );
              const current = lock.rows[0];
              if (
                current === undefined ||
                z.coerce.number().parse(current.retention_control_sequence) !==
                  highWater.sequence ||
                current.retention_control_hash !== highWater.hash
              )
                throw new Error('Retention control fence changed');
              const page = await query<{
                cursor_expires_at: Date | string | null;
                cursor_id: string | null;
                eligible_delta: string | number;
                examined_delta: string | number;
                outcome: string;
              }>(
                client,
                claimed.retentionKind === 'workflow_run_input'
                  ? `select * from app.execute_workflow_run_input_retention_page(
                      $1,$2,$3,$4,$5,$6)`
                  : `select * from app.execute_standard_retention_page(
                      $1,$2,$3,$4,$5,$6)`,
                [
                  claimed.batchId,
                  claimed.leaseToken,
                  claimed.leaseFence,
                  options.pageSize,
                  highWater.sequence,
                  highWater.hash,
                ],
                signal,
              );
              const row = page.rows[0];
              if (row === undefined)
                throw new Error('Destructive retention page was not returned');
              return row;
            },
          );
          const outcome = z
            .enum(['completed', 'paused', 'progressed', 'stale'])
            .parse(row.outcome);
          const examinedDelta = z.coerce
            .number()
            .int()
            .nonnegative()
            .parse(row.examined_delta);
          const eligibleDelta = z.coerce
            .number()
            .int()
            .nonnegative()
            .parse(row.eligible_delta);
          examinedCount += examinedDelta;
          eligibleCount += eligibleDelta;
          if (outcome !== 'progressed') {
            return Object.freeze({
              batchId: claimed.batchId,
              eligibleCount,
              examinedCount,
              pageCount,
              retentionKind: claimed.retentionKind,
              status: outcome,
              workspaceId: claimed.workspaceId,
            });
          }
        } catch {
          await release(claimed, signal).catch(() => undefined);
          return Object.freeze({
            batchId: claimed.batchId,
            eligibleCount,
            examinedCount,
            pageCount,
            retentionKind: claimed.retentionKind,
            status: 'released' as const,
            workspaceId: claimed.workspaceId,
          });
        }
      }
      await release(claimed, signal);
      return Object.freeze({
        batchId: claimed.batchId,
        eligibleCount,
        examinedCount,
        pageCount: options.maxPagesPerBatch,
        retentionKind: claimed.retentionKind,
        status: 'released' as const,
        workspaceId: claimed.workspaceId,
      });
    },
  });
}
