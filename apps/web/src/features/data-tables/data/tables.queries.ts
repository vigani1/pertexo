import { queryOptions } from '@tanstack/react-query';
import type { DataTableQuery } from '@pertexo/node-sdk';
import { readTables, readRows, type TableScope } from './tables.api';
export const tableKeys = {
  scope: (scope: TableScope) =>
    [
      'identity',
      scope.userId,
      'workspace',
      scope.workspaceId,
      'data-tables',
    ] as const,
};
export function tablesQuery(scope: TableScope) {
  return queryOptions({
    queryKey: [...tableKeys.scope(scope), 'list'],
    queryFn: ({ signal }) => readTables(scope, signal),
    staleTime: 10_000,
    gcTime: 0,
    retry: false,
  });
}
export function tableRowsQuery(
  scope: TableScope,
  tableId: string,
  query: DataTableQuery,
) {
  return queryOptions({
    queryKey: [...tableKeys.scope(scope), tableId, 'rows', query],
    queryFn: ({ signal }) => readRows(scope, tableId, query, signal),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}
