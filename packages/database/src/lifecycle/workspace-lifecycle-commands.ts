import { createDatabasePool } from '../platform/postgres-telemetry.js';
import type { Pool } from 'pg';
import type { PoolClient, QueryConfig, QueryResult } from 'pg';
import { z } from 'zod';
import { sha256HexSchema as hashSchema } from '../validation/persisted-primitives.js';

import type { DatabaseConfig } from '../config.js';
import { raceWithSignal } from './control-ledger-postgres.js';
import {
  inRetentionTransaction,
  withWorkspaceDestructiveOperationLock,
} from './retention-transaction.js';
import {
  EXPECTED_MIGRATION_HEAD,
  MINIMUM_POSTGRES_MAJOR,
} from '../platform/readiness.js';

const uuidSchema = z.uuid();
const commandTypeSchema = z.enum(['deletion_requested', 'deletion_restored']);

export type WorkspaceLifecycleCommandType = z.infer<typeof commandTypeSchema>;

export interface WorkspaceLifecycleLedgerRecord {
  readonly actorRef: string;
  readonly commandId: string;
  readonly commandType: string;
  readonly occurredAt: string;
  readonly previousHash: string;
  readonly reason: string;
  readonly recordHash: string;
  readonly schemaVersion: number;
  readonly sequence: number;
  readonly subjectId: string;
  readonly workspaceId: string;
}

export interface WorkspaceLifecycleLedger {
  append(input: {
    readonly actorRef: string;
    readonly commandId: string;
    readonly commandType: WorkspaceLifecycleCommandType;
    readonly occurredAt: string;
    readonly previousHash: string;
    readonly reason: string;
    readonly sequence: number;
    readonly signal?: AbortSignal;
    readonly subjectId: string;
    readonly workspaceId: string;
  }): Promise<WorkspaceLifecycleLedgerRecord>;
  reconcile(input: {
    readonly maxRecords: number;
    readonly projectedHash: string;
    readonly projectedSequence: number;
    readonly repairCommandId: string;
    readonly signal?: AbortSignal;
    readonly workspaceId: string;
  }): Promise<{
    readonly hasMore: boolean;
    readonly pageEndHash: string;
    readonly pageEndSequence: number;
    readonly reachedHighWater: boolean;
    readonly records: readonly WorkspaceLifecycleLedgerRecord[];
  }>;
}

export type WorkspaceLifecycleCommandOutcome =
  | Readonly<{ status: 'idle' }>
  | Readonly<{
      commandType: WorkspaceLifecycleCommandType;
      operationId: string;
      status: 'completed' | 'failed' | 'released' | 'stale';
    }>;

export interface WorkspaceLifecycleCommandCoordinator {
  checkReadiness(input: {
    readonly expectedLifecycleCommandRole: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  close(): Promise<void>;
  processNext(input?: {
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceLifecycleCommandOutcome>;
}

interface ClaimedOperation {
  [key: string]: unknown;
  actor_user_id: string;
  command_type: string;
  lease_fence: string | number;
  lease_token: string;
  occurred_at: Date | string;
  operation_id: string;
  reason: string;
  workspace_id: string;
}

interface LockedOperation {
  [key: string]: unknown;
  append_authorized: boolean;
  control_hash: string;
  control_sequence: string | number;
}

interface PreparedLifecycleAppend {
  readonly expectedSequence: number;
  readonly previousHash: string;
}

const optionsSchema = z
  .object({
    externalOperationTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(30_000),
    leaseDurationMs: z.number().int().min(2_000).max(300_000).default(180_000),
    leaseOwner: z.string().trim().min(1).max(128),
    lockTimeoutMs: z.number().int().min(100).max(60_000).default(10_000),
    statementTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(30_000),
  })
  .refine(
    ({ externalOperationTimeoutMs, leaseDurationMs, statementTimeoutMs }) =>
      externalOperationTimeoutMs + statementTimeoutMs * 4 + 5_000 <
      leaseDurationMs,
    { message: 'Command timeout budget must be shorter than the lease' },
  );

type WorkspaceLifecycleCommandOptions = z.input<typeof optionsSchema>;

function sequence(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error('Invalid lifecycle control sequence');
  return parsed;
}

function occurredAt(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf()))
    throw new Error('Invalid lifecycle occurrence time');
  return date.toISOString();
}

function verifyRecord(
  record: WorkspaceLifecycleLedgerRecord,
  operation: ClaimedOperation,
  previousHash: string,
  expectedSequence: number,
): void {
  if (
    record.actorRef !== operation.actor_user_id ||
    record.commandId !== operation.operation_id ||
    record.commandType !== operation.command_type ||
    record.occurredAt !== occurredAt(operation.occurred_at) ||
    record.previousHash !== previousHash ||
    record.reason !== operation.reason ||
    record.sequence !== expectedSequence ||
    record.subjectId !== operation.workspace_id ||
    record.workspaceId !== operation.workspace_id ||
    record.schemaVersion !== 1 ||
    !hashSchema.safeParse(record.recordHash).success ||
    record.recordHash === record.previousHash
  )
    throw new Error('Lifecycle ledger record conflicts with durable operation');
}

async function query<
  Row extends Record<string, unknown> = Record<string, unknown>,
>(
  client: PoolClient,
  text: string,
  values: readonly unknown[] = [],
  signal?: AbortSignal,
): Promise<QueryResult<Row>> {
  signal?.throwIfAborted();
  const request: QueryConfig<unknown[]> & { readonly signal?: AbortSignal } = {
    ...(signal === undefined ? {} : { signal }),
    text,
    values: [...values],
  };
  try {
    const result = await client.query<Row>(request);
    signal?.throwIfAborted();
    return result;
  } catch (error: unknown) {
    if (signal?.aborted === true) throw signal.reason;
    throw error;
  }
}

function stableFailureCode(error: unknown): string | undefined {
  let code: unknown;
  let message: unknown;
  try {
    if (typeof error !== 'object' || error === null) return undefined;
    code = Reflect.get(error, 'code');
    message = Reflect.get(error, 'message');
  } catch {
    return undefined;
  }
  if (
    code === '42501' &&
    message === 'workspace lifecycle authorization was lost'
  )
    return 'authorization_lost';
  if (
    code === '55000' &&
    message === 'workspace lifecycle transition is no longer valid'
  )
    return 'invalid_transition';
  return undefined;
}

async function inTransaction<T>(
  pool: Pool,
  options: Readonly<{ lockTimeoutMs: number; statementTimeoutMs: number }>,
  signal: AbortSignal | undefined,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return inRetentionTransaction(pool, options, signal, work);
}

export function createWorkspaceLifecycleCommandCoordinator(
  config: DatabaseConfig,
  ledger: WorkspaceLifecycleLedger,
  input: WorkspaceLifecycleCommandOptions,
): WorkspaceLifecycleCommandCoordinator {
  if (config.max < 2)
    throw new RangeError(
      'Workspace lifecycle coordination requires a database pool of at least 2 connections',
    );
  const options = optionsSchema.parse(input);
  const pool = createDatabasePool({
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    idleTimeoutMillis: config.idleTimeoutMillis,
    max: config.max,
  });
  const transactionOptions = {
    lockTimeoutMs: options.lockTimeoutMs,
    statementTimeoutMs: options.statementTimeoutMs,
  };
  let closePromise: Promise<void> | undefined;

  const coordinator: WorkspaceLifecycleCommandCoordinator = {
    checkReadiness: async (input): Promise<void> => {
      const parsedInput = z
        .object({
          expectedLifecycleCommandRole: z.string().regex(/^[a-z_][a-z0-9_]*$/u),
          signal: z
            .custom<AbortSignal>((value) => value instanceof AbortSignal)
            .optional(),
        })
        .strict()
        .parse(input);
      const result = await inTransaction(
        pool,
        transactionOptions,
        parsedInput.signal,
        (client) =>
          query<{
            boundary_compatible: boolean;
            current_user: string;
            migration_head: string | null;
            postgres_major: number;
          }>(
            client,
            `select current_user,
          current_setting('server_version_num')::integer/10000 postgres_major,
          (select name from pertexo_internal.schema_migrations
            order by name desc limit 1) migration_head,
          current_user=$1::name
            and not role.rolsuper
            and not role.rolbypassrls
            and not pg_has_role(current_user,$2::name,'MEMBER')
            and not pg_has_role(current_user,$3::name,'MEMBER')
            and has_function_privilege(current_user,
              'app.claim_workspace_lifecycle_operations(character varying,integer,interval)','EXECUTE')
            and has_function_privilege(current_user,
              'app.lock_workspace_lifecycle_operation(uuid,uuid,bigint)','EXECUTE')
            and has_function_privilege(current_user,
              'app.authorize_workspace_lifecycle_append(uuid,uuid,bigint)','EXECUTE')
            and has_function_privilege(current_user,
              'app.project_and_complete_workspace_lifecycle_operation(uuid,uuid,bigint,bigint,character,character)','EXECUTE')
            and has_function_privilege(current_user,
              'app.release_workspace_lifecycle_operation(uuid,uuid,bigint)','EXECUTE')
            and has_function_privilege(current_user,
              'app.fail_workspace_lifecycle_operation(uuid,uuid,bigint,character varying)','EXECUTE')
            and not exists(select 1 from (values
              ('workspace_lifecycle_operations'),
              ('workspace_control_ledger_projection'),
              ('workspaces'),('sessions')) protected(table_name)
              where has_any_column_privilege(current_user,
                'app.'||protected.table_name,'SELECT,INSERT,UPDATE,REFERENCES')
                or has_table_privilege(current_user,
                  'app.'||protected.table_name,'DELETE,TRUNCATE,TRIGGER'))
            as boundary_compatible
          from pg_roles role where role.rolname=current_user`,
            [
              parsedInput.expectedLifecycleCommandRole,
              config.ownerRole,
              config.workerRuntimeRole,
            ],
            parsedInput.signal,
          ),
      );
      const row = result.rows[0];
      if (
        result.rowCount !== 1 ||
        row?.current_user !== parsedInput.expectedLifecycleCommandRole ||
        row.postgres_major < MINIMUM_POSTGRES_MAJOR ||
        row.migration_head !== EXPECTED_MIGRATION_HEAD ||
        !row.boundary_compatible
      )
        throw new Error('Lifecycle command database boundary is incompatible');
    },
    close: () => (closePromise ??= pool.end()),
    processNext: async (processInput = {}) => {
      const { signal } = processInput;
      signal?.throwIfAborted();
      const claim = await inTransaction(
        pool,
        transactionOptions,
        signal,
        (client) =>
          query<ClaimedOperation>(
            client,
            `select * from app.claim_workspace_lifecycle_operations(
                 $1,1,make_interval(secs=>$2::double precision)
               )`,
            [options.leaseOwner, options.leaseDurationMs / 1_000],
            signal,
          ),
      );
      const operation = claim.rows[0];
      if (operation === undefined) return { status: 'idle' };
      const commandType = commandTypeSchema.parse(operation.command_type);
      const fence = sequence(operation.lease_fence);
      const lease: [string, string, number] = [
        operation.operation_id,
        operation.lease_token,
        fence,
      ];

      try {
        // Commit the authorization decision before external I/O so an exact
        // partial append remains repairable even if authorization later changes.
        await inTransaction(
          pool,
          transactionOptions,
          signal,
          async (client) => {
            await query(
              client,
              'select app.lock_workspace_lifecycle_operation($1,$2,$3)',
              lease,
              signal,
            );
            await query(
              client,
              'select app.authorize_workspace_lifecycle_append($1,$2,$3)',
              lease,
              signal,
            );
          },
        );

        await withWorkspaceDestructiveOperationLock(
          pool,
          operation.workspace_id,
          signal,
          async () => {
            const prepared = await inTransaction(
              pool,
              transactionOptions,
              signal,
              async (client) => {
                const lockedResult = await query<LockedOperation>(
                  client,
                  'select * from app.lock_workspace_lifecycle_operation($1,$2,$3)',
                  lease,
                  signal,
                );
                const locked = lockedResult.rows[0];
                if (locked?.append_authorized !== true)
                  throw new Error(
                    'Lifecycle command authorization is not durable',
                  );
                return Object.freeze({
                  expectedSequence: sequence(locked.control_sequence) + 1,
                  previousHash: hashSchema.parse(locked.control_hash),
                } satisfies PreparedLifecycleAppend);
              },
            );

            const operationSignal = AbortSignal.any([
              ...(signal === undefined ? [] : [signal]),
              AbortSignal.timeout(options.externalOperationTimeoutMs),
            ]);
            const reconciliation = await raceWithSignal(
              ledger.reconcile({
                maxRecords: 2,
                projectedHash: prepared.previousHash,
                projectedSequence: prepared.expectedSequence - 1,
                repairCommandId: operation.operation_id,
                signal: operationSignal,
                workspaceId: uuidSchema.parse(operation.workspace_id),
              }),
              operationSignal,
            );
            if (
              reconciliation.hasMore ||
              !reconciliation.reachedHighWater ||
              reconciliation.records.length > 1
            )
              throw new Error(
                'Lifecycle ledger has unrelated unprojected commands',
              );
            let record = reconciliation.records[0];
            const pageEndSequence =
              record?.sequence ?? reconciliation.pageEndSequence;
            const pageEndHash =
              record?.recordHash ?? reconciliation.pageEndHash;
            if (
              reconciliation.pageEndSequence !== pageEndSequence ||
              reconciliation.pageEndHash !== pageEndHash ||
              (record === undefined &&
                (pageEndSequence !== prepared.expectedSequence - 1 ||
                  pageEndHash !== prepared.previousHash))
            )
              throw new Error('Lifecycle ledger high water is inconsistent');
            record ??= await raceWithSignal(
              ledger.append({
                actorRef: operation.actor_user_id,
                commandId: operation.operation_id,
                commandType,
                occurredAt: occurredAt(operation.occurred_at),
                previousHash: prepared.previousHash,
                reason: operation.reason,
                sequence: prepared.expectedSequence,
                signal: operationSignal,
                subjectId: operation.workspace_id,
                workspaceId: operation.workspace_id,
              }),
              operationSignal,
            );
            verifyRecord(
              record,
              operation,
              prepared.previousHash,
              prepared.expectedSequence,
            );
            signal?.throwIfAborted();

            await inTransaction(
              pool,
              transactionOptions,
              signal,
              async (client) => {
                const lockedResult = await query<LockedOperation>(
                  client,
                  'select * from app.lock_workspace_lifecycle_operation($1,$2,$3)',
                  lease,
                  signal,
                );
                const locked = lockedResult.rows[0];
                if (
                  locked?.append_authorized !== true ||
                  sequence(locked.control_sequence) + 1 !==
                    prepared.expectedSequence ||
                  hashSchema.parse(locked.control_hash) !==
                    prepared.previousHash
                )
                  throw new Error('Lifecycle command projection fence changed');
                const projected = await query<{ projected: boolean }>(
                  client,
                  `select app.project_and_complete_workspace_lifecycle_operation(
               $1,$2,$3,$4,$5,$6
             ) projected`,
                  [
                    ...lease,
                    record.sequence,
                    record.previousHash,
                    record.recordHash,
                  ],
                  signal,
                );
                z.boolean().parse(projected.rows[0]?.projected);
              },
            );
          },
        );
        return {
          commandType,
          operationId: operation.operation_id,
          status: 'completed',
        };
      } catch (error: unknown) {
        const failureCode = stableFailureCode(error);
        const cleanupSignal = AbortSignal.timeout(options.statementTimeoutMs);
        let changed: boolean;
        try {
          changed = await inTransaction(
            pool,
            transactionOptions,
            cleanupSignal,
            async (client) => {
              const result = await query<{ changed: boolean }>(
                client,
                failureCode === undefined
                  ? 'select app.release_workspace_lifecycle_operation($1,$2,$3) changed'
                  : 'select app.fail_workspace_lifecycle_operation($1,$2,$3,$4) changed',
                failureCode === undefined ? lease : [...lease, failureCode],
                cleanupSignal,
              );
              return z.boolean().parse(result.rows[0]?.changed);
            },
          );
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            'Lifecycle command failure and lease cleanup both failed',
          );
        }
        if (failureCode === undefined) {
          if (signal?.aborted === true) signal.throwIfAborted();
          throw error;
        }
        return {
          commandType,
          operationId: operation.operation_id,
          status: changed ? 'failed' : 'stale',
        };
      }
    },
  };
  return Object.freeze(coordinator);
}
