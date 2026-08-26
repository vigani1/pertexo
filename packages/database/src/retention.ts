import { Pool, type QueryResult } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from './config.js';
import { EXPECTED_MIGRATION_HEAD } from './readiness.js';

const uuidSchema = z.uuid();
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const dateSchema = z.date().refine((value) => Number.isFinite(value.getTime()));

export interface StartWorkflowRunInputRetentionDryRunInput {
  readonly batchId: string;
  readonly cutoffAt: Date;
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly signal?: AbortSignal;
  readonly workspaceId: string;
}

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
  readonly retentionKind: 'workflow_run_input';
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
      status: 'completed' | 'stale';
      workspaceId: string;
    }>;

export interface RetentionDatabaseOptions {
  readonly leaseOwner: string;
  readonly leaseSeconds?: number;
  readonly maxPagesPerBatch?: number;
  readonly pageSize?: number;
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
  startDryRun(
    input: StartWorkflowRunInputRetentionDryRunInput,
  ): Promise<string>;
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
    retentionKind: z.literal('workflow_run_input').parse(row.retention_kind),
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
            and not has_table_privilege(current_user,'app.workflow_runs','SELECT,INSERT,UPDATE,DELETE')
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
            status: page.completed ? 'completed' : 'stale',
            workspaceId: claimed.workspaceId,
          });
        }
      }
      throw new Error('Retention dry-run page bound exceeded');
    },
    startDryRun: async (input: StartWorkflowRunInputRetentionDryRunInput) => {
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
          $4::timestamptz,true,$5::varchar,$6::varchar) batch_id`,
        [
          parsed.batchId,
          parsed.workspaceId,
          parsed.idempotencyKey,
          parsed.cutoffAt,
          parsed.requestedBy,
          parsed.reason,
        ],
        parsed.signal,
      );
      return uuidSchema.parse(result.rows[0]?.batch_id);
    },
  };
  return Object.freeze(database);
}
