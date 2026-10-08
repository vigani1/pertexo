import { createDatabasePool } from '../platform/postgres-telemetry.js';
import type { Pool } from 'pg';
import type { PoolClient, QueryConfig, QueryResult } from 'pg';
import { z } from 'zod';
import { sha256HexSchema as hashSchema } from '../validation/persisted-primitives.js';

import type { DatabaseConfig } from '../config.js';
import { workspaceControlRecordHash } from './control-record.js';
import {
  inRetentionTransaction,
  withWorkspaceDestructiveOperationLock,
} from './retention-transaction.js';
import { checkDatabaseReadiness } from '../platform/readiness.js';

const commandTypeSchema = z.enum(['deletion_requested', 'deletion_restored']);

export type WorkspaceLifecycleCommandType = z.infer<typeof commandTypeSchema>;

export type WorkspaceLifecycleCommandOutcome =
  | Readonly<{ status: 'idle' }>
  | Readonly<{
      commandType: WorkspaceLifecycleCommandType;
      operationId: string;
      status: 'completed' | 'failed' | 'released' | 'stale';
    }>;

export interface WorkspaceLifecycleCommandCoordinator {
  checkReadiness(signal?: AbortSignal): Promise<void>;
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

const optionsSchema = z
  .object({
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
    ({ leaseDurationMs, statementTimeoutMs }) =>
      statementTimeoutMs * 4 + 5_000 < leaseDurationMs,
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
    checkReadiness: async (signal): Promise<void> => {
      signal?.throwIfAborted();
      await checkDatabaseReadiness(pool);
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
        await withWorkspaceDestructiveOperationLock(
          pool,
          operation.workspace_id,
          signal,
          () =>
            inTransaction(pool, transactionOptions, signal, async (client) => {
              await query(
                client,
                'select app.authorize_workspace_lifecycle_append($1,$2,$3)',
                lease,
                signal,
              );
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
              const previousHash = hashSchema.parse(locked.control_hash);
              const nextSequence = sequence(locked.control_sequence) + 1;
              const recordHash = workspaceControlRecordHash({
                actorRef: operation.actor_user_id,
                commandId: operation.operation_id,
                commandType,
                occurredAt: occurredAt(operation.occurred_at),
                previousHash,
                reason: operation.reason,
                sequence: nextSequence,
                workspaceId: operation.workspace_id,
              });
              const projected = await query<{ projected: boolean }>(
                client,
                `select app.project_and_complete_workspace_lifecycle_operation(
                   $1,$2,$3,$4,$5,$6
                 ) projected`,
                [...lease, nextSequence, previousHash, recordHash],
                signal,
              );
              z.boolean().parse(projected.rows[0]?.projected);
            }),
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
