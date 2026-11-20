import { POSTGRES_LIMITS, postgresCredentialSchema } from '@pertexo/contracts';
import {
  withProviderCredential,
  type NodeExecutionInvocation,
  type NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { createProviderBeforeDispatch } from '../../providers/provider-dispatch-fence.js';
import { connectionLookupFailure } from '../../providers/provider.errors.js';
import { registerProviderExecutor } from '../../providers/provider-executor.js';
import type { PostgresClient, PostgresSession } from '../postgres-client.js';
import {
  DATABASE_EXECUTOR,
  POSTGRES_CONNECTION_SLOT,
} from './execute.definition.js';
import { databaseFailure, postgresExecutorFailure } from './execute.errors.js';
import type { DatabaseConfig, DatabaseInput } from './execute.schemas.js';
import { rowStatement } from './row-statement.js';

const profile = { providerKey: 'postgres', authTypes: ['postgres'] } as const;

export function createDatabaseExecutorRegistration(
  client?: PostgresClient,
): NodeExecutorRegistration {
  return registerProviderExecutor(DATABASE_EXECUTOR, undefined, (invocation) =>
    execute(client, invocation),
  );
}

async function execute(
  client: PostgresClient | undefined,
  invocation: NodeExecutionInvocation<unknown, unknown>,
) {
  const { runtime, signal } = invocation;
  const config = invocation.config as DatabaseConfig;
  const input = invocation.input as DatabaseInput;
  const connectionId = invocation.connectionRefs[POSTGRES_CONNECTION_SLOT];
  const connections = runtime?.connections;
  const assertCurrent = connections?.assertCurrent;
  if (
    runtime === undefined ||
    assertCurrent === undefined ||
    connections === undefined ||
    connectionId === undefined ||
    client === undefined
  )
    throw databaseFailure('failed', 'configuration', {
      possiblyDispatched: false,
    });
  if (runtime.providerDispatchUnresolved ?? false)
    throw databaseFailure('outcome_unknown', 'provider', {
      possiblyDispatched: true,
    });

  const resolved = await connections
    .resolve({
      connectionId,
      expectedProviderKey: profile.providerKey,
      expectedAuthType: 'postgres',
      purpose: DATABASE_EXECUTOR.key,
      signal,
    })
    .catch((error: unknown) => {
      throw connectionLookupFailure(error, {
        failure: databaseFailure,
        runtime,
        signal,
      });
    });
  return withProviderCredential(
    resolved,
    {
      ...profile,
      connectionId,
      schema: postgresCredentialSchema,
      refuse: (reason) =>
        databaseFailure('failed', reason, { possiblyDispatched: false }),
    },
    async (credential) => {
      const run = prepareOperation(config, input);
      const outcome = await client
        .execute(
          credential,
          {
            signal,
            timeoutMillis:
              config.timeoutMillis ?? POSTGRES_LIMITS.defaultTimeoutMillis,
            maxRows: config.maxRows ?? POSTGRES_LIMITS.defaultRows,
            beforeDispatch: createProviderBeforeDispatch({
              assertCurrent,
              connectionId,
              expectedProviderKey: profile.providerKey,
              expectedAuthType: 'postgres',
              secretVersionId: resolved.secretVersionId,
              runtime,
              signal,
            }),
          },
          run,
        )
        .catch((error: unknown) => {
          throw connectionLookupFailure(error, {
            failure: databaseFailure,
            runtime,
            signal,
          });
        });
      if (outcome.kind === 'failed') throw postgresExecutorFailure(outcome);
      return { items: outcome.result.rows, rowCount: outcome.result.rowCount };
    },
  );
}

function prepareOperation(config: DatabaseConfig, input: DatabaseInput) {
  if (config.operation === 'query')
    return (session: PostgresSession) =>
      session.query(config.sql, input.parameters);
  const statements = input.rows?.map((row) => {
    const statement = rowStatement(config, row);
    if (statement === undefined) throw invalidColumns();
    return statement;
  });
  if (statements === undefined) throw invalidColumns();
  const columns = [
    ...new Set(statements.flatMap((statement) => statement.columns)),
  ];
  return async (session: PostgresSession) => {
    await session.requireColumns(config.schema, config.table, columns);
    const rows: Record<string, unknown>[] = [];
    let rowCount = 0;
    for (const statement of statements) {
      const result = await session.query(statement.text, statement.values);
      rows.push(...result.rows);
      rowCount += result.rowCount;
    }
    return { rows, rowCount };
  };
}

function invalidColumns() {
  return postgresExecutorFailure({
    kind: 'failed',
    code: 'invalid_columns',
    ambiguous: false,
  });
}
