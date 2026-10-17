import { appendAuditFact } from '../governance/audit/append.js';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@pertexo/workflow-model';
import { DataTableError } from '@pertexo/node-sdk';
import type { PoolClient } from 'pg';
import type { DatabaseConfig } from '../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../platform/pool/runtime.js';
import {
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '../tenant-access/transactions.js';
import {
  lockWorkspaceAuthority,
  readWorkspaceAuthority,
} from '../tenant-access/workspaces/authority.js';
import { rolesForCapability } from '../tenant-access/policy.js';
import { generatePersistedId } from '../platform/persisted-id.js';
import { claimCommand, completeCommand } from '../platform/idempotency.js';
import type { DataTableScope, DataTablesStore } from './contract.js';
import {
  readQuotas,
  requireTable,
  projectTable,
  TABLE_COLUMNS,
  type StoredTable,
} from './read.js';
import { findRows } from './queries.js';
import { editTableSchema } from './columns/change.js';
import { exportTableCsv } from './csv/export.js';
import {
  mutateRows,
  insertTableBatch,
  translateTableConstraint,
} from './mutate.js';
export function createDataTablesStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): DataTablesStore {
  const lease = acquireDatabasePool(config, runtime);
  const read = <T>(
    scope: DataTableScope,
    work: (client: PoolClient) => Promise<T>,
  ) =>
    withTenantScopedReadClient(
      lease.pool,
      scope,
      async (client) => {
        await readWorkspaceAuthority(
          client,
          scope.workspaceId,
          scope.actorId,
          rolesForCapability('workspace:read'),
          ['active', 'suspended', 'pending_deletion'],
        );
        return work(client);
      },
      scope.signal === undefined ? {} : { signal: scope.signal },
    );
  const write = <T>(
    scope: DataTableScope,
    work: (client: PoolClient) => Promise<T>,
    admin = false,
  ) =>
    withTenantScopedClient(
      lease.pool,
      scope,
      async (client) => {
        await lockWorkspaceAuthority(
          client,
          scope.workspaceId,
          scope.actorId,
          admin ? ['owner', 'admin'] : rolesForCapability('workflow:update'),
        );
        return work(client);
      },
      scope.signal === undefined ? {} : { signal: scope.signal },
    ).catch(translateTableConstraint);
  const command = async <T extends object>(
    client: PoolClient,
    input: DataTableScope & { idempotencyKey: string },
    operation: string,
    audit:
      | ((result: T) => Readonly<{
          targetId: string;
          targetType: 'workspace' | 'data_table';
          metadata?: Readonly<Record<string, unknown>>;
        }>)
      | null,
    request: unknown,
    work: () => Promise<T>,
  ): Promise<T> => {
    const identity = {
      workspaceId: input.workspaceId,
      scope: input.actorId,
      operation,
      idempotencyKey: input.idempotencyKey,
    };
    const prior = await claimCommand(client, {
      ...identity,
      resourceId: input.workspaceId,
      requestHash: createHash('sha256')
        .update(canonicalJson(request))
        .digest('hex'),
    });
    if (prior !== null) return prior as T;
    const result = await work();
    if (audit !== null)
      await appendAuditFact(client, {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        action: operation,
        ...audit(result),
      });
    await completeCommand(client, identity, result);
    return result;
  };
  return {
    close: () => lease.close(),
    list: (input) =>
      read(input, async (client) => ({
        quotas: await readQuotas(client, input.workspaceId),
        tables: (
          await client.query<StoredTable>(
            `select ${TABLE_COLUMNS} from app.workspace_data_tables where workspace_id=$1 order by name limit 100`,
            [input.workspaceId],
          )
        ).rows.map(projectTable),
      })),
    create: (input) =>
      write(input, (client) =>
        command(
          client,
          input,
          'data.tables.create',
          (result) => ({
            targetType: 'data_table',
            targetId: result.id,
            metadata: { columnCount: input.columns.length },
          }),
          {
            name: input.name,
            columns: input.columns,
            keyColumn: input.keyColumn ?? null,
          },
          async () => {
            const quota = await readQuotas(client, input.workspaceId, true);
            if (
              quota.tableCount >= quota.tableLimit ||
              input.columns.length > quota.columnLimit
            )
              throw new DataTableError(
                'quota_exceeded',
                'Table or column limit reached. Ask an admin to raise it.',
              );
            if (
              input.keyColumn !== undefined &&
              input.keyColumn !== null &&
              !input.columns.some(
                (column) =>
                  column.name === input.keyColumn &&
                  column.required &&
                  ['text', 'number', 'date'].includes(column.type),
              )
            )
              throw new DataTableError(
                'invalid_values',
                'The unique key must be a required text, number or date column.',
              );
            const id = generatePersistedId();
            await client.query(
              'insert into app.workspace_data_tables(workspace_id,id,name,columns_json,key_column) values($1,$2,$3,$4::jsonb,$5)',
              [
                input.workspaceId,
                id,
                input.name,
                JSON.stringify(
                  input.columns.map((column) => ({
                    ...column,
                    id: column.name,
                  })),
                ),
                input.keyColumn ?? null,
              ],
            );
            await client.query(
              'update app.workspace_data_table_quotas set table_count=table_count+1 where workspace_id=$1',
              [input.workspaceId],
            );
            return { id };
          },
        ),
      ),
    editSchema: (input) =>
      write(input, (client) =>
        command(
          client,
          input,
          'data.tables.schema.edit',
          null,
          {
            tableId: input.tableId,
            expectedRevision: input.expectedRevision,
            change: input.change,
          },
          () => editTableSchema(client, input),
        ),
      ),
    exportCsv: async (input) => {
      const table = await read(input, (client) =>
        requireTable(client, input.workspaceId, { id: input.tableId }),
      );
      const csv = exportTableCsv(
        (work) => read(input, work),
        input.workspaceId,
        table,
        input.query,
        input.signal,
      );
      await input.consume(csv, table);
    },
    remove: (input) =>
      write(input, (client) =>
        command(
          client,
          input,
          'data.tables.remove',
          () => ({ targetType: 'data_table', targetId: input.tableId }),
          { tableId: input.tableId, expectedRevision: input.expectedRevision },
          async () => {
            await readQuotas(client, input.workspaceId, true);
            const table = await requireTable(
              client,
              input.workspaceId,
              { id: input.tableId },
              true,
            );
            if (table.revision !== input.expectedRevision)
              throw new DataTableError(
                'conflict',
                'This table changed. Reload before deleting.',
              );
            await client.query(
              'delete from app.workspace_data_tables where workspace_id=$1 and id=$2',
              [input.workspaceId, table.id],
            );
            await client.query(
              'update app.workspace_data_table_quotas set table_count=table_count-1,stored_bytes=stored_bytes-$2 where workspace_id=$1',
              [input.workspaceId, table.storedBytes],
            );
            return { removed: true as const };
          },
        ),
      ),
    configure: (input) =>
      write(
        input,
        (client) =>
          command(
            client,
            input,
            'data.tables.configure',
            () => ({
              targetType: 'workspace',
              targetId: input.workspaceId,
              metadata: {
                tableLimit: input.tableLimit,
                columnLimit: input.columnLimit,
                rowLimit: input.rowLimit,
                byteLimit: input.byteLimit,
              },
            }),
            {
              tableLimit: input.tableLimit,
              columnLimit: input.columnLimit,
              rowLimit: input.rowLimit,
              byteLimit: input.byteLimit,
            },
            async () => {
              const current = await readQuotas(client, input.workspaceId, true);
              const max = (
                await client.query<{ columns: number; rows: number }>(
                  'select coalesce(max(jsonb_array_length(columns_json)),0)::int columns,coalesce(max(row_count),0)::int rows from app.workspace_data_tables where workspace_id=$1',
                  [input.workspaceId],
                )
              ).rows[0];
              if (
                current.tableCount > input.tableLimit ||
                current.storedBytes > input.byteLimit ||
                (max?.columns ?? 0) > input.columnLimit ||
                (max?.rows ?? 0) > input.rowLimit
              )
                throw new DataTableError(
                  'quota_exceeded',
                  'Limits cannot be lower than current table use.',
                );
              await client.query(
                'update app.workspace_data_table_quotas set table_limit=$2,column_limit=$3,row_limit=$4,byte_limit=$5 where workspace_id=$1',
                [
                  input.workspaceId,
                  input.tableLimit,
                  input.columnLimit,
                  input.rowLimit,
                  input.byteLimit,
                ],
              );
              return readQuotas(client, input.workspaceId);
            },
          ),
        true,
      ),
    find: (input) =>
      read(input, async (client) =>
        findRows(
          client,
          input.workspaceId,
          await requireTable(client, input.workspaceId, { id: input.tableId }),
          input.query,
        ),
      ),
    write: (input) =>
      write(input, async (client) => {
        // HTTP receipts retain identities/counts only; row payloads follow table access.
        const receipt = await command(
          client,
          input,
          'data.tables.rows.write',
          (result) => ({
            targetType: 'data_table',
            targetId: input.tableId,
            metadata: {
              operation: input.command.operation,
              affected: result.affected,
            },
          }),
          {
            tableId: input.tableId,
            command: input.command,
            rowId: input.rowId ?? null,
            expectedRevision: input.expectedRevision ?? null,
          },
          async () => {
            const quotas = await readQuotas(client, input.workspaceId, true);
            const table = await requireTable(
              client,
              input.workspaceId,
              { id: input.tableId },
              true,
            );
            if (input.command.table !== table.name)
              throw new DataTableError(
                'conflict',
                'The table name does not match this command. Reload before writing.',
              );
            const result = await mutateRows(
              client,
              input.workspaceId,
              table,
              quotas,
              input.command,
              input.rowId === undefined
                ? undefined
                : {
                    rowId: input.rowId,
                    expectedRevision: input.expectedRevision ?? 0,
                  },
            );
            return {
              rows: result.rows.map((row) => ({
                id: row.id,
                revision: row.revision,
              })),
              affected: result.affected,
            };
          },
        );
        return receipt;
      }),
    importRows: (input) =>
      write(input, (client) =>
        command(
          client,
          input,
          'data.tables.rows.import',
          (result) => ({
            targetType: 'data_table',
            targetId: input.tableId,
            metadata: { affected: result.affected },
          }),
          'prepareRows' in input
            ? { tableId: input.tableId, csv: input.csv }
            : { tableId: input.tableId, rows: input.rows },
          async () => {
            const quota = await readQuotas(client, input.workspaceId, true);
            const table = await requireTable(
              client,
              input.workspaceId,
              { id: input.tableId },
              true,
            );
            return insertTableBatch(
              client,
              input.workspaceId,
              table,
              quota,
              'prepareRows' in input ? input.prepareRows(table) : input.rows,
            );
          },
        ),
      ),
  };
}
