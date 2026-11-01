import { createHash } from 'node:crypto';

import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  appendAuditFact,
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import { dataTableWriteReceipts as receipts } from '@pertexo/database/schema';
import {
  bindDataTableCommand,
  DataTableError,
  dataTableResultSchema,
  projectBoundDataTableResult,
  resolveDataTableBindings,
  type DataTableResult,
} from '@pertexo/node-sdk';
import { canonicalJson } from '@pertexo/workflow-model';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import {
  assertCapabilityExecution,
  lockCapabilityExecution,
} from '../attempts/dispatch/fence.repository.js';
import type {
  DataTableAttempt,
  DataTableDefinition,
  ExecuteTableCommandInput,
} from './contract.js';
import { readQuotas, requireTable } from './definitions.queries.js';
import { translateWorkerFailure } from './errors.js';
import { findRows } from './rows/find.queries.js';
import { mutateRows } from './rows/mutate.repository.js';

export type WorkerDataTablesStore = ReturnType<
  typeof createWorkerDataTablesStore
>;

export function createWorkerDataTablesStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  return {
    close: () => lease.close(),
    execute: (input: ExecuteTableCommandInput): Promise<DataTableResult> =>
      withTenantScopedClient(
        lease.pool,
        { workspaceId: input.workspaceId },
        async (client) => {
          await lockCapabilityExecution(client, input);
          return input.command.operation === 'find'
            ? executeFind(client, input)
            : executeWrite(client, input);
        },
        { signal: input.signal },
      ).catch(translateWorkerFailure),
  };
}

async function executeFind(
  client: PoolClient,
  input: ExecuteTableCommandInput,
): Promise<DataTableResult> {
  await assertCapabilityExecution(client, input);
  const table = await requireTable(client, input.workspaceId, {
    name: input.command.table,
  });
  const names = columnNames(table, input);
  const command = bindDataTableCommand(input.command, names);
  if (command.operation !== 'find') throw new Error('Read operation changed');
  return projectBoundDataTableResult(
    await findRows(client, input.workspaceId, table, command.query),
    names,
  );
}

async function executeWrite(
  client: PoolClient,
  input: ExecuteTableCommandInput,
): Promise<DataTableResult> {
  const quotas = await readQuotas(client, input.workspaceId, { lock: true });
  await assertCapabilityExecution(client, input, { requireDispatch: true });
  const requestHash = tableRequestHash(input);
  const prior = await readReceipt(client, input);
  if (prior !== undefined) {
    if (prior.requestHash !== requestHash)
      throw new DataTableError(
        'conflict',
        'The retried data table command changed.',
      );
    return dataTableResultSchema.parse(JSON.parse(prior.resultJson));
  }
  const table = await requireTable(
    client,
    input.workspaceId,
    { name: input.command.table },
    { lock: true },
  );
  const names = columnNames(table, input);
  const command = bindDataTableCommand(input.command, names);
  if (command.operation === 'find') throw new Error('Write operation changed');
  const result = projectBoundDataTableResult(
    await mutateRows(client, input.workspaceId, { table, quotas, command }),
    names,
  );
  await assertCapabilityExecution(client, input, { requireDispatch: true });
  await drizzle(client)
    .insert(receipts)
    .values({
      workspaceId: input.workspaceId,
      executionId: input.runId,
      invocationId: input.nodeRunId,
      runId: input.previewRunId === undefined ? input.runId : null,
      previewRunId: input.previewRunId ?? null,
      requestHash,
      result: JSON.stringify(result),
    })
    .catch(rethrowQueryFailure);
  await appendAuditFact(client, {
    workspaceId: input.workspaceId,
    action: 'data.tables.rows.write',
    targetType: 'data_table',
    targetId: table.id,
    metadata: {
      actorKind: 'workflow',
      runId: input.runId,
      invocationId: input.nodeRunId,
      operation: command.operation,
      affected: result.affected,
    },
  });
  return result;
}

function columnNames(
  table: DataTableDefinition,
  input: ExecuteTableCommandInput,
) {
  return resolveDataTableBindings({
    columns: table.columns,
    bindings: input.columnBindings,
    hasRemovedColumns: table.hasRemovedColumns,
  });
}

async function readReceipt(client: PoolClient, attempt: DataTableAttempt) {
  const [prior] = await drizzle(client)
    .select({ requestHash: receipts.requestHash, resultJson: receipts.result })
    .from(receipts)
    .where(
      and(
        eq(receipts.workspaceId, attempt.workspaceId),
        eq(receipts.executionId, attempt.runId),
        eq(receipts.invocationId, attempt.nodeRunId),
      ),
    )
    .catch(rethrowQueryFailure);
  return prior;
}

function tableRequestHash(input: ExecuteTableCommandInput): string {
  return createHash('sha256')
    .update(
      canonicalJson(
        input.columnBindings === undefined
          ? input.command
          : { command: input.command, columnBindings: input.columnBindings },
      ),
    )
    .digest('hex');
}
