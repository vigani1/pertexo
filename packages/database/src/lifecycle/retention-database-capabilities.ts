import type { Pool } from 'pg';
import { z } from 'zod';

import { EXPECTED_MIGRATION_HEAD } from '../platform/readiness.js';
import { reapTransientData } from './transient-data-retention.js';
import type {
  OperatorMaintenanceRerunResult,
  RegionalReplicaLagObservation,
  RetentionDatabase,
  RetentionDryRunClaim,
  RetentionDryRunPageResult,
  RetentionDryRunProcessResult,
  RetentionScheduleResult,
  StartWorkflowRunInputRetentionInput,
} from './retention-contracts.js';
import {
  mapRetentionDryRunClaim,
  type ParsedRetentionDatabaseOptions,
  retentionBoundedText,
  retentionDateSchema,
  retentionKindSchema,
  retentionQuery as query,
  retentionUuidSchema as uuidSchema,
} from './retention-support.js';

const RETENTION_SCHEDULE_BATCH_SIZE = 25;

type DryRunCapability = Pick<
  RetentionDatabase,
  | 'claimDryRuns'
  | 'executeDryRunPage'
  | 'processNext'
  | 'reapTransientData'
  | 'startDryRun'
  | 'startEnforcement'
>;

export function createRetentionDryRunCapability(
  pool: Pool,
  options: ParsedRetentionDatabaseOptions,
): DryRunCapability {
  const claim = async (signal?: AbortSignal) => {
    const result = await query(
      pool,
      'select * from app.claim_retention_dry_run_batches($1,$2,$3)',
      [options.leaseOwner, 1, options.leaseSeconds],
      signal,
    );
    return result.rows.map(mapRetentionDryRunClaim);
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
    let outcome: 'completed' | 'progressed' | 'stale';
    if (standard) {
      outcome = z.enum(['completed', 'progressed', 'stale']).parse(row.outcome);
    } else if (z.boolean().parse(row.completed)) {
      outcome = 'completed';
    } else if (
      examinedDelta === 0 &&
      eligibleDelta === 0 &&
      row.cursor_expires_at === null &&
      row.cursor_id === null
    ) {
      outcome = 'stale';
    } else {
      outcome = 'progressed';
    }
    return Object.freeze({
      completed: outcome === 'completed',
      cursorExpiresAt:
        row.cursor_expires_at === null || row.cursor_expires_at === undefined
          ? null
          : z.coerce.date().parse(row.cursor_expires_at),
      cursorId:
        row.cursor_id === null || row.cursor_id === undefined
          ? null
          : uuidSchema.parse(row.cursor_id),
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
        cutoffAt: retentionDateSchema,
        idempotencyKey: retentionBoundedText(128),
        reason: retentionBoundedText(512),
        requestedBy: retentionBoundedText(128),
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
  const processNext = async (
    signal?: AbortSignal,
  ): Promise<RetentionDryRunProcessResult> => {
    const claimed = (await claim(signal))[0];
    if (claimed === undefined) return { status: 'idle' };
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
      if (page.completed || page.stale)
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
    throw new Error('Retention dry-run page bound exceeded');
  };
  return Object.freeze({
    claimDryRuns: claim,
    executeDryRunPage,
    processNext,
    reapTransientData: (signal?: AbortSignal) =>
      reapTransientData(pool, options.pageSize, signal),
    startDryRun: (input: StartWorkflowRunInputRetentionInput) =>
      startBatch(input, true),
    startEnforcement: (input: StartWorkflowRunInputRetentionInput) =>
      startBatch(input, false),
  });
}

export function createRetentionOperatorRecoveryCapability(
  pool: Pool,
): Pick<RetentionDatabase, 'processOperatorRerun'> {
  return Object.freeze({
    processOperatorRerun: async (
      signal?: AbortSignal,
    ): Promise<OperatorMaintenanceRerunResult | null> => {
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
  });
}

export function createRetentionSchedulingCapability(
  pool: Pool,
): Pick<RetentionDatabase, 'scheduleEnforcement'> {
  return Object.freeze({
    scheduleEnforcement: async (
      signal?: AbortSignal,
    ): Promise<RetentionScheduleResult> => {
      const result = await query<{
        cutoff_at: Date | string;
        scanned_count: number | string;
        scheduled_count: number | string;
      }>(
        pool,
        'select * from app.schedule_workflow_run_input_retention($1)',
        [RETENTION_SCHEDULE_BATCH_SIZE],
        signal,
      );
      const row = result.rows[0];
      if (row === undefined)
        throw new Error('Retention schedule result was not returned');
      return Object.freeze({
        capacityLimited:
          z.coerce.number().int().parse(row.scanned_count) ===
          RETENTION_SCHEDULE_BATCH_SIZE,
        cutoffAt: z.coerce.date().parse(row.cutoff_at),
        scannedCount: z.coerce
          .number()
          .int()
          .min(0)
          .max(RETENTION_SCHEDULE_BATCH_SIZE)
          .parse(row.scanned_count),
        scheduledCount: z.coerce
          .number()
          .int()
          .min(0)
          .max(RETENTION_SCHEDULE_BATCH_SIZE)
          .parse(row.scheduled_count),
      });
    },
  });
}

export function createRetentionHealthCapability(
  pool: Pool,
): Pick<RetentionDatabase, 'checkReadiness' | 'recordRegionalReplicaLag'> {
  return Object.freeze({
    checkReadiness: async ({ expectedMaintenanceRole, signal }) => {
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
            and has_function_privilege(current_user,'app.record_regional_replica_lag(character varying,character varying,bigint,integer)','EXECUTE')
            and has_function_privilege(current_user,'app.process_operator_maintenance_rerun()','EXECUTE')
            and has_function_privilege(current_user,'app.reap_transient_data(integer)','EXECUTE')
            and has_function_privilege(current_user,'app.start_retention_batch(uuid,uuid,character varying,character varying,timestamp with time zone,boolean,character varying,character varying)','EXECUTE')
            and has_function_privilege(current_user,'app.claim_retention_dry_run_batches(character varying,integer,integer)','EXECUTE')
            and has_function_privilege(current_user,'app.execute_workflow_run_input_retention_dry_run_page(uuid,uuid,bigint,integer)','EXECUTE')
            and has_function_privilege(current_user,'app.execute_standard_retention_dry_run_page(uuid,uuid,bigint,integer)','EXECUTE')
            and has_function_privilege(current_user,'app.claim_retention_destructive_batches(character varying,integer,integer)','EXECUTE')
            and has_function_privilege(current_user,'app.release_retention_batch(uuid,uuid,bigint)','EXECUTE')
            and has_function_privilege(current_user,'app.execute_workflow_run_input_retention_page(uuid,uuid,bigint,integer,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,'app.find_due_preview_cleanup(integer)','EXECUTE')
            and has_function_privilege(current_user,'app.prepare_preview_cleanup_step(uuid,uuid,integer,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,'app.complete_preview_artifact_cleanup(uuid,uuid,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,'app.finish_preview_cleanup(uuid,uuid,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,'app.schedule_workflow_run_input_retention(integer)','EXECUTE')
            and has_function_privilege(current_user,'app.execute_standard_retention_page(uuid,uuid,bigint,integer,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,'app.find_due_run_artifact_retention(integer)','EXECUTE')
            and has_function_privilege(current_user,'app.prepare_run_artifact_retention(uuid,uuid,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,'app.complete_run_artifact_retention(uuid,uuid,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,'app.defer_run_artifact_retention(uuid,uuid,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,'app.find_due_workspace_purge()','EXECUTE')
            and has_function_privilege(current_user,'app.workspace_purge_repair_command_id(uuid)','EXECUTE')
            and has_function_privilege(current_user,'app.prepare_workspace_purge_job(uuid,bigint,character,character varying,interval)','EXECUTE')
            and has_function_privilege(current_user,'app.release_workspace_purge_job(uuid,uuid,bigint)','EXECUTE')
            and has_function_privilege(current_user,'app.project_workspace_purge_started(uuid,uuid,bigint,bigint,character,character)','EXECUTE')
            and has_function_privilege(current_user,'app.claim_workspace_purge_step(uuid,bigint,character,character varying,interval)','EXECUTE')
            and has_function_privilege(current_user,'app.release_workspace_purge_step(uuid,uuid,bigint)','EXECUTE')
            and has_function_privilege(current_user,'app.find_due_workspace_purge_step()','EXECUTE')
            and has_function_privilege(current_user,'app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,'app.checkpoint_workspace_object_versions_page(uuid,uuid,bigint,integer,boolean,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,'app.find_due_workspace_purge_completion()','EXECUTE')
            and has_function_privilege(current_user,'app.prepare_workspace_purge_completion(uuid,bigint,character,character varying,interval)','EXECUTE')
            and has_function_privilege(current_user,'app.authorize_workspace_purge_completion_append(uuid,uuid,bigint,bigint,character)','EXECUTE')
            and has_function_privilege(current_user,'app.project_workspace_purge_completion(uuid,uuid,bigint,bigint,character,character)','EXECUTE')
            and not has_function_privilege(current_user,'app.claim_retention_batches(character varying,integer,integer)','EXECUTE')
            and not has_function_privilege(current_user,'app.checkpoint_retention_batch(uuid,uuid,bigint,timestamp with time zone,uuid,integer,integer,boolean)','EXECUTE')
            and not has_table_privilege(current_user,'app.workflow_runs','SELECT,INSERT,UPDATE,DELETE')
            and not has_table_privilege(current_user,'app.retention_schedule_state','SELECT,INSERT,UPDATE,DELETE') as compatible`,
        [role],
        signal,
      );
      const row = result.rows[0];
      if (
        row?.compatible !== true ||
        row.current_user !== role ||
        row.migration_head !== EXPECTED_MIGRATION_HEAD
      )
        throw new Error('Retention database authority is not ready');
    },
    recordRegionalReplicaLag: async (
      applicationName: string,
      signal?: AbortSignal,
    ): Promise<RegionalReplicaLagObservation> => {
      const expectedApplicationName =
        retentionBoundedText(128).parse(applicationName);
      const observation = await query<{
        replay_lag_millis: string | null;
        replication_state: string;
        session_count: number;
      }>(
        pool,
        `select count(*)::integer session_count,
          case when count(*)=1 then max(replica.state) else 'unavailable' end replication_state,
          case when count(*)=1 then max(case when replica.replay_lsn=pg_current_wal_lsn() then 0 when replica.replay_lag is null then null else ceil(extract(epoch from replica.replay_lag)*1000)::bigint end) else null end replay_lag_millis
        from pg_stat_replication replica where replica.application_name=$1`,
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
        replicationState: retentionBoundedText(32).parse(row.replication_state),
        status: z
          .enum(['open', 'paused', 'unavailable'])
          .parse(recorded.rows[0]?.status),
      });
    },
  });
}
