import { POSTGRES_LIMITS, postgresCredentialSchema } from '@pertexo/contracts';
import {
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
  withProviderCredential,
  type NodeConnectionRuntime,
} from '@pertexo/node-sdk/server';
import {
  PollFailure,
  DATABASE_POLL_TRIGGER,
  type DatabasePollConfig,
} from '@pertexo/workflow-model';
import { canonicalEventKey } from '@pertexo/workflow-model/server';
import { z } from 'zod';

import { quoteIdentifier } from '../identifier.js';
import type { PostgresClient } from '../postgres-client.js';

const profile = { providerKey: 'postgres', authTypes: ['postgres'] } as const;
const rowSchema = z.record(z.string(), z.json());
const identityValue = z.string().min(1);

export async function fetchDatabasePollItems(
  input: Readonly<{
    config: DatabasePollConfig;
    connectionId: string;
    maxItems: number;
    signal: AbortSignal;
  }>,
  client: PostgresClient,
  connections?: NodeConnectionRuntime,
) {
  const { connectionId, config, signal, maxItems } = input;
  const assertCurrent = connections?.assertCurrent;
  if (connections === undefined || assertCurrent === undefined)
    throw new PollFailure('database.authentication_failed');

  const binding = {
    connectionId,
    expectedProviderKey: profile.providerKey,
    expectedAuthType: 'postgres',
    signal,
  } as const;

  try {
    const resolved = await connections.resolve({
      ...binding,
      purpose: DATABASE_POLL_TRIGGER.key,
    });
    return await withProviderCredential(
      resolved,
      {
        ...profile,
        connectionId,
        schema: postgresCredentialSchema,
        refuse: () => new PollFailure('database.authentication_failed'),
      },
      async (credential) => {
        const { schema, table, keyColumn, orderingColumn } = config;
        // Keep node-postgres column decoding for the payload (including bigint).
        // Read identity values separately as text to preserve ordering precision.
        let keyField = '';
        let orderField = '';
        const outcome = await client.execute(
          credential,
          {
            signal,
            readOnly: true,
            maxRows: maxItems,
            timeoutMillis: POSTGRES_LIMITS.defaultTimeoutMillis,
            beforeDispatch: () =>
              assertCurrent({
                ...binding,
                secretVersionId: resolved.secretVersionId,
              }),
          },
          async (session) => {
            const columns = new Set(
              await session.requireColumns(schema, table, [
                keyColumn,
                orderingColumn,
              ]),
            );
            await session.requireUniqueKey(schema, table, keyColumn);
            keyField = availableColumn(columns, 'pertexo_poll_key');
            orderField = availableColumn(columns, 'pertexo_poll_order');
            const key = quoteIdentifier(keyColumn);
            const order = quoteIdentifier(orderingColumn);
            return session.query(
              `select source_row.*, source_row.${key}::text as ${keyField},
                      source_row.${order}::text as ${orderField}
                 from ${quoteIdentifier(schema)}.${quoteIdentifier(table)} as source_row
                order by source_row.${order} desc, source_row.${key} desc
                limit $1`,
              [maxItems],
            );
          },
        );
        if (outcome.kind === 'failed')
          throw new PollFailure(`database.${outcome.code}`);
        const seen = new Set<string>();
        return outcome.result.rows.map(
          ({ [keyField]: rawKey, [orderField]: rawOrder, ...row }) => {
            const key = identityValue.safeParse(rawKey);
            const ordering = identityValue.safeParse(rawOrder);
            if (!key.success || !ordering.success || seen.has(key.data))
              throw new PollFailure('database.poll_invalid_key');
            const identity =
              config.mode === 'new'
                ? key.data
                : JSON.stringify([key.data, ordering.data]);
            if (canonicalEventKey(identity) === undefined)
              throw new PollFailure('database.poll_invalid_key');
            seen.add(key.data);
            return { key: identity, item: rowSchema.parse(row) };
          },
        );
      },
    );
  } catch (error: unknown) {
    signal.throwIfAborted();
    if (error instanceof PollFailure) throw error;
    if (error instanceof ProviderCredentialInvalidError)
      throw new PollFailure('database.authentication_failed');
    if (error instanceof ProviderExecutionRateLimitError)
      throw new PollFailure('database.poll_rate_limited');
    throw new PollFailure('database.connection_failed');
  }
}

function availableColumn(columns: ReadonlySet<string>, prefix: string): string {
  let number = 0;
  while (columns.has(`${prefix}_${String(number)}`)) number++;
  return `${prefix}_${String(number)}`;
}
