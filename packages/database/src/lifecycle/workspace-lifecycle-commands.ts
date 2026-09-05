import { createDatabasePool } from '../platform/postgres-telemetry.js';
import type { Pool } from 'pg';
import type { PoolClient, QueryConfig, QueryResult } from 'pg';
import { z } from 'zod';
import { sha256HexSchema as hashSchema } from '../validation/persisted-primitives.js';

import type { DatabaseConfig } from '../config.js';
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

function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = (): void => {
      finish(() => {
        // Preserve AbortSignal reasons, including non-Error reasons.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(signal.reason);
      });
    };
    operation.then(
      (value) => {
        finish(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        finish(() => {
          // Preserve adapter rejection values unchanged.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(error);
        });
      },
    );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function acquirePoolClient(
  pool: Pool,
  signal?: AbortSignal,
): Promise<PoolClient> {
  const connection = pool.connect();
  if (signal === undefined) return connection;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    rejectAbort?.(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.race([connection, aborted]);
  } catch (error: unknown) {
    if (signal.aborted) {
      void connection.then(
        (client) => {
          client.release();
        },
        () => undefined,
      );
      throw signal.reason;
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
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
  if (typeof error !== 'object' || error === null) return undefined;
  const code = 'code' in error ? error.code : undefined;
  const message = 'message' in error ? error.message : undefined;
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
  const client = await acquirePoolClient(pool, signal);
  let releaseError: Error | undefined;
  try {
    await query(client, 'begin', [], signal);
    await query(
      client,
      "select set_config('lock_timeout',$1,true)",
      [`${String(options.lockTimeoutMs)}ms`],
      signal,
    );
    await query(
      client,
      "select set_config('statement_timeout',$1,true)",
      [`${String(options.statementTimeoutMs)}ms`],
      signal,
    );
    const result = await work(client);
    await query(client, 'commit', [], signal);
    return result;
  } catch (error: unknown) {
    if (signal?.aborted === true) {
      releaseError =
        signal.reason instanceof Error
          ? signal.reason
          : new Error('Lifecycle database operation was cancelled');
    }
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release(releaseError);
  }
}

export function createWorkspaceLifecycleCommandCoordinator(
  config: DatabaseConfig,
  ledger: WorkspaceLifecycleLedger,
  input: WorkspaceLifecycleCommandOptions,
): WorkspaceLifecycleCommandCoordinator {
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
      const result = await pool.query<{
        boundary_compatible: boolean;
        current_user: string;
        migration_head: string | null;
        postgres_major: number;
      }>({
        ...(parsedInput.signal === undefined
          ? {}
          : { signal: parsedInput.signal }),
        text: `select current_user,
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
        values: [
          parsedInput.expectedLifecycleCommandRole,
          config.ownerRole,
          config.workerRuntimeRole,
        ],
      });
      parsedInput.signal?.throwIfAborted();
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
    close: async () => pool.end(),
    processNext: async (processInput = {}) => {
      const { signal } = processInput;
      signal?.throwIfAborted();
      const claim = await pool.query<ClaimedOperation>({
        ...(signal === undefined ? {} : { signal }),
        text: `select * from app.claim_workspace_lifecycle_operations(
                 $1,1,make_interval(secs=>$2::double precision)
               )`,
        values: [options.leaseOwner, options.leaseDurationMs / 1_000],
      });
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
              throw new Error('Lifecycle command authorization is not durable');
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
        const pageEndHash = record?.recordHash ?? reconciliation.pageEndHash;
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
              hashSchema.parse(locked.control_hash) !== prepared.previousHash
            )
              throw new Error('Lifecycle command projection fence changed');
            await query(
              client,
              `select app.project_and_complete_workspace_lifecycle_operation(
               $1,$2,$3,$4,$5,$6
             )`,
              [
                ...lease,
                record.sequence,
                record.previousHash,
                record.recordHash,
              ],
              signal,
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
        const result = await pool.query<{ changed: boolean }>(
          failureCode === undefined
            ? 'select app.release_workspace_lifecycle_operation($1,$2,$3) changed'
            : 'select app.fail_workspace_lifecycle_operation($1,$2,$3,$4) changed',
          failureCode === undefined ? lease : [...lease, failureCode],
        );
        if (signal?.aborted === true) throw signal.reason;
        return {
          commandType,
          operationId: operation.operation_id,
          status:
            result.rows[0]?.changed === true
              ? failureCode === undefined
                ? 'released'
                : 'failed'
              : 'stale',
        };
      }
    },
  };
  return Object.freeze(coordinator);
}
