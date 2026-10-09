import type { Pool, QueryResult } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import { OperatorCommandConflictError } from './operator-command-errors.js';
import type {
  GenericOperatorCommandResult,
  OperatorCommandDatabaseOptions,
} from './operator-command-contracts.js';
import { createDatabasePool } from '../platform/postgres-telemetry.js';
import { checkDatabaseReadiness } from '../platform/readiness.js';
import { runOperatorTransaction } from './operator-transaction.js';

type RuntimeOptions = Readonly<{
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
  transactionDecoded<Row extends Record<string, unknown>, Result>(
    text: string,
    values: readonly unknown[],
    decode: (result: QueryResult<Row>) => Result,
    signal?: AbortSignal,
  ): Promise<Result>;
}

const genericCommandRowSchema = z.object({
  command_id: z.uuid(),
  command_outcome: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u),
  command_status: z.enum(['completed', 'failed', 'pending']),
  replayed: z.boolean(),
  result: z.record(z.string(), z.unknown()),
});

type DecodedGenericCommand = Readonly<{
  conflict: boolean;
  result: GenericOperatorCommandResult;
}>;

function decodeGenericCommand(
  response: QueryResult<Record<string, unknown>>,
): DecodedGenericCommand {
  const source = response.rows[0];
  if (source === undefined)
    throw new Error('Operator command returned no result');
  const row = genericCommandRowSchema.parse(source);
  return Object.freeze({
    conflict: row.command_outcome === 'conflict',
    result: Object.freeze({
      commandId: row.command_id,
      outcome: row.command_outcome,
      replayed: row.replayed,
      result: Object.freeze(row.result),
      status: row.command_status,
    }),
  });
}

function parseOptions(input: OperatorCommandDatabaseOptions): RuntimeOptions {
  return z
    .object({
      lockTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
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
  inputOptions: OperatorCommandDatabaseOptions,
): OperatorCommandRuntime {
  const {
    ownerRole: _ownerRole,
    workerRuntimeRole: _workerRole,
    ...poolConfig
  } = config;
  const options = parseOptions(inputOptions);
  const pool = createDatabasePool({ ...poolConfig, max: 1 });
  pool.on('error', () => undefined);
  let closePromise: Promise<void> | undefined;

  const transaction = async <Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<QueryResult<Row>> =>
    runOperatorTransaction<Row>(pool, options, text, values, signal);

  const transactionDecoded = <Row extends Record<string, unknown>, Result>(
    text: string,
    values: readonly unknown[],
    decode: (result: QueryResult<Row>) => Result,
    signal?: AbortSignal,
  ): Promise<Result> =>
    runOperatorTransaction<Row, Result>(
      pool,
      options,
      text,
      values,
      signal,
      decode,
    );

  const execute = async (
    text: string,
    values: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<GenericOperatorCommandResult> => {
    const decoded = await transactionDecoded<
      Record<string, unknown>,
      DecodedGenericCommand
    >(text, values, decodeGenericCommand, signal);
    if (decoded.conflict) throw new OperatorCommandConflictError();
    return decoded.result;
  };

  return Object.freeze({
    checkReadiness: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      await checkDatabaseReadiness(pool);
    },
    close: () =>
      (closePromise ??= Promise.resolve().then(async () => pool.end())),
    execute,
    transaction,
    transactionDecoded,
  });
}
