import {
  dataTablesResponseSchema,
  dataTableCreatedSchema,
  dataTableRemovedSchema,
  dataTableQuotasSchema,
  dataTableResultSchema,
  dataTableWriteReceiptSchema,
  dataTableImportedSchema,
  dataTableSchemaEditedSchema,
  type DataTableSchemaEdit,
  type DataTableExportQuery,
  type DataTableCreate,
  type DataTableLimits,
  type DataTableWrite,
} from '@pertexo/contracts';
import type { DataTableQuery } from '@pertexo/node-sdk';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
export type TableScope = WorkspaceApiScope;
function path(scope: TableScope): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/data-tables`;
}
export function readTables(scope: TableScope, signal: AbortSignal) {
  return scope.apiClient.request({
    path: path(scope),
    signal,
    response: {
      kind: 'json',
      decode: (value) => dataTablesResponseSchema.parse(value),
    },
  });
}
export function readRows(
  scope: TableScope,
  tableId: string,
  query: DataTableQuery,
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: `${path(scope)}/${encodeURIComponent(tableId)}/rows/query`,
    method: 'POST',
    body: query,
    signal,
    response: {
      kind: 'json',
      decode: (value) => dataTableResultSchema.parse(value),
    },
  });
}
export type TableCommand =
  | { kind: 'schema'; tableId: string; body: DataTableSchemaEdit }
  | { kind: 'create'; body: DataTableCreate }
  | { kind: 'limits'; body: DataTableLimits }
  | { kind: 'remove'; tableId: string; body: { expectedRevision: number } }
  | { kind: 'write'; tableId: string; body: DataTableWrite }
  | { kind: 'import'; tableId: string; body: { csv: string } };
export async function sendTableCommand(
  scope: TableScope,
  command: TableCommand,
  key: string,
) {
  const headers = { 'Idempotency-Key': key };
  switch (command.kind) {
    case 'schema':
      return scope.apiClient.request({
        path: `${path(scope)}/${encodeURIComponent(command.tableId)}/schema`,
        method: 'PUT',
        body: command.body,
        headers,
        response: {
          kind: 'json',
          decode: (value) => dataTableSchemaEditedSchema.parse(value),
        },
      });
    case 'create':
      return scope.apiClient.request({
        path: path(scope),
        method: 'POST',
        body: command.body,
        headers,
        response: {
          kind: 'json',
          decode: (value) => dataTableCreatedSchema.parse(value),
        },
      });
    case 'limits':
      return scope.apiClient.request({
        path: `${path(scope)}/limits`,
        method: 'PUT',
        body: command.body,
        headers,
        response: {
          kind: 'json',
          decode: (value) => dataTableQuotasSchema.parse(value),
        },
      });
    case 'remove':
      return scope.apiClient.request({
        path: `${path(scope)}/${encodeURIComponent(command.tableId)}`,
        method: 'DELETE',
        body: command.body,
        headers,
        response: {
          kind: 'json',
          decode: (value) => dataTableRemovedSchema.parse(value),
        },
      });
    case 'write':
      return scope.apiClient.request({
        path: `${path(scope)}/${encodeURIComponent(command.tableId)}/rows`,
        method: 'POST',
        body: command.body,
        headers,
        response: {
          kind: 'json',
          decode: (value) => dataTableWriteReceiptSchema.parse(value),
        },
      });
    case 'import':
      return scope.apiClient.request({
        path: `${path(scope)}/${encodeURIComponent(command.tableId)}/import`,
        method: 'POST',
        body: command.body,
        headers,
        response: {
          kind: 'json',
          decode: (value) => dataTableImportedSchema.parse(value),
        },
      });
  }
}

export function exportRows(
  scope: TableScope,
  tableId: string,
  query: DataTableExportQuery,
): void {
  scope.apiClient.download({
    path: `${path(scope)}/${encodeURIComponent(tableId)}/export`,
    body: query,
  });
}
