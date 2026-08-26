import { Pool, type PoolClient, type QueryResult } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from './config.js';
import type { ControlLedger } from './control-ledger-coordinator.js';
import { EXPECTED_MIGRATION_HEAD } from './readiness.js';

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
  readonly stale: boolean;
}

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
  scheduleEnforcement(signal?: AbortSignal): Promise<RetentionScheduleResult>;
  startDryRun(
    input: StartWorkflowRunInputRetentionDryRunInput,
  ): Promise<string>;
  startEnforcement(input: StartWorkflowRunInputRetentionInput): Promise<string>;
}

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
  pool: Pool,
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
    cutoffAt: new Date(row.cutoff_at as string | Date),
    requestedBy: boundedText(128).parse(row.requested_by),
    reason: boundedText(512).parse(row.reason),
    cursorExpiresAt:
      row.cursor_expires_at === null
        ? null
        : new Date(row.cursor_expires_at as string | Date),
    cursorId: row.cursor_id === null ? null : uuidSchema.parse(row.cursor_id),
    leaseToken: uuidSchema.parse(row.lease_token),
    leaseFence: z.coerce.number().int().positive().parse(row.lease_fence),
    leaseExpiresAt: new Date(row.lease_expires_at as string | Date),
  });
}

export function createRetentionDatabase(
  config: DatabaseConfig,
  inputOptions: RetentionDatabaseOptions,
): RetentionDatabase {
  const options = optionsSchema.parse(inputOptions);
  const pool = new Pool({
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    idleTimeoutMillis: config.idleTimeoutMillis,
    max: config.max,
  });

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
    const result = await query(
      pool,
      `select * from app.execute_workflow_run_input_retention_dry_run_page(
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
    const completed = z.boolean().parse(row.completed);
    const cursorExpiresAt =
      row.cursor_expires_at === null
        ? null
        : new Date(row.cursor_expires_at as string | Date);
    const cursorId =
      row.cursor_id === null ? null : uuidSchema.parse(row.cursor_id);
    return Object.freeze({
      completed,
      cursorExpiresAt,
      cursorId,
      eligibleDelta,
      examinedDelta,
      stale:
        !completed &&
        examinedDelta === 0 &&
        eligibleDelta === 0 &&
        cursorExpiresAt === null &&
        cursorId === null,
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
        $1::uuid,$2::uuid,$3::varchar,'workflow_run_input',
        $4::timestamptz,$5::boolean,$6::varchar,$7::varchar) batch_id`,
      [
        parsed.batchId,
        parsed.workspaceId,
        parsed.idempotencyKey,
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
            and has_function_privilege(current_user,
              'app.start_retention_batch(uuid,uuid,character varying,character varying,timestamp with time zone,boolean,character varying,character varying)','EXECUTE')
            and has_function_privilege(current_user,
              'app.claim_retention_dry_run_batches(character varying,integer,integer)','EXECUTE')
            and has_function_privilege(current_user,
              'app.execute_workflow_run_input_retention_dry_run_page(uuid,uuid,bigint,integer)','EXECUTE')
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
    claimDryRuns: claim,
    close: () => pool.end(),
    executeDryRunPage,
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
        cutoffAt: new Date(row.cutoff_at),
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

function transactionQuery<Row extends Record<string, unknown>>(
  client: PoolClient,
  text: string,
  values: readonly unknown[],
  signal?: AbortSignal,
): Promise<QueryResult<Row>> {
  signal?.throwIfAborted();
  return client.query<Row>({
    text,
    values: [...values],
    ...(signal === undefined ? {} : { signal }),
  });
}

export function createRetentionEnforcementCoordinator(
  config: DatabaseConfig,
  ledger: ControlLedger,
  inputOptions: RetentionEnforcementCoordinatorOptions,
): RetentionEnforcementCoordinator {
  const options = enforcementOptionsSchema.parse(inputOptions);
  const pool = new Pool({
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    idleTimeoutMillis: config.idleTimeoutMillis,
    max: config.max,
  });

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
    close: () => pool.end(),
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
        const client = await pool.connect();
        let transactionComplete = false;
        try {
          await transactionQuery(client, 'begin', [], signal);
          await transactionQuery(
            client,
            `set local lock_timeout='${String(options.lockTimeoutMs)}ms';
             set local statement_timeout='${String(options.statementTimeoutMs)}ms';
             set local idle_in_transaction_session_timeout='0'`,
            [],
            signal,
          );
          const lock = await transactionQuery<{
            retention_control_hash: string;
            retention_control_sequence: string | number;
          }>(
            client,
            'select * from app.lock_workspace_control_ledger($1)',
            [claimed.workspaceId],
            signal,
          );
          const highWater = lock.rows[0];
          if (highWater === undefined)
            throw new Error(
              'Retention workspace control lock was not returned',
            );
          const sequence = z.coerce
            .number()
            .int()
            .nonnegative()
            .parse(highWater.retention_control_sequence);
          const hash = z
            .string()
            .regex(/^[0-9a-f]{64}$/u)
            .parse(highWater.retention_control_hash);
          const timeoutSignal = AbortSignal.timeout(
            options.externalOperationTimeoutMs,
          );
          const externalSignal =
            signal === undefined
              ? timeoutSignal
              : AbortSignal.any([signal, timeoutSignal]);
          const reconciliation = await ledger.reconcile({
            maxRecords: 1,
            projectedHash: hash,
            projectedSequence: sequence,
            signal: externalSignal,
            workspaceId: claimed.workspaceId,
          });
          if (
            !reconciliation.reachedHighWater ||
            reconciliation.hasMore ||
            reconciliation.records.length !== 0 ||
            reconciliation.pageEndSequence !== sequence ||
            reconciliation.pageEndHash !== hash
          ) {
            throw new Error(
              'Retention control ledger is not exactly projected',
            );
          }
          const page = await transactionQuery<{
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
              sequence,
              hash,
            ],
            signal,
          );
          const row = page.rows[0];
          if (row === undefined)
            throw new Error('Destructive retention page was not returned');
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
          await transactionQuery(client, 'commit', [], signal);
          transactionComplete = true;
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
          if (!transactionComplete)
            await client.query('rollback').catch(() => undefined);
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
        } finally {
          client.release();
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
