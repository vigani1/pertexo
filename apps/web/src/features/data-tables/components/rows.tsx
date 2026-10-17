import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DataTableDefinition } from '@pertexo/contracts';
import type { DataTableQuery, DataTableRow } from '@pertexo/node-sdk';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import { ExportTableRows } from './transfer/export';
import {
  sendTableCommand,
  type TableScope,
  type TableCommand,
} from '../data/tables.api';
import { tableRowsQuery, tableKeys } from '../data/tables.queries';
import { TableRowEditor } from './row-editor';
import { ImportTableCsv } from './import';
import { DataTableFilters } from './filters';
import { TableCommandFeedback } from './command-feedback';
export function DataTableRows({
  scope,
  table,
  editable,
}: Readonly<{
  scope: TableScope;
  table: DataTableDefinition;
  editable: boolean;
}>) {
  const cache = useQueryClient();
  const [query, setQuery] = useState<DataTableQuery>({
    filters: [],
    limit: 50,
    offset: 0,
  });
  const [editing, setEditing] = useState<{
    row?: DataTableRow;
    table: DataTableDefinition;
  }>();
  const [importing, setImporting] = useState(false);
  const rows = useQuery(tableRowsQuery(scope, table.id, query));
  const command = useRetainedCommand(
    (body: TableCommand, key: string) => sendTableCommand(scope, body, key),
    async () => {
      await cache.invalidateQueries({ queryKey: tableKeys.scope(scope) });
    },
    { action: 'deleting this row' },
  );
  const locked = command.pending || command.uncertain;
  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex flex-wrap gap-2">
        {editable ? (
          <>
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                setEditing({ table });
              }}
            >
              Add row
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setImporting(true);
              }}
            >
              Import CSV
            </Button>
          </>
        ) : null}
        <ExportTableRows scope={scope} table={table} query={query} />
        <Button
          type="button"
          variant="ghost"
          onClick={() => void rows.refetch()}
        >
          Refresh rows
        </Button>
      </div>
      <DataTableFilters table={table} query={query} onChange={setQuery} />
      <TableCommandFeedback command={command} />
      {rows.isError ? (
        <Notice tone="warning">
          Rows could not be loaded. Narrow the filter or refresh to try again.
        </Notice>
      ) : null}
      {rows.isPending ? <p role="status">Loading rows…</p> : null}
      <div className="max-w-full overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{table.name} rows</caption>
          <thead>
            <tr className="border-b border-border">
              {table.columns.map((column) => (
                <th
                  key={column.name}
                  scope="col"
                  className="px-4 py-3 font-medium whitespace-nowrap"
                >
                  {column.name}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {column.type}
                  </span>
                </th>
              ))}
              {editable ? (
                <th scope="col" className="px-4 py-3">
                  Actions
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.data?.rows.map((row) => (
              <tr key={row.id} className="border-b border-border last:border-0">
                {table.columns.map((column) => (
                  <td
                    key={column.name}
                    className="max-w-72 min-w-28 px-4 py-3 align-top"
                  >
                    <div className="line-clamp-4 break-words whitespace-pre-wrap">
                      {typeof row.values[column.name] === 'object'
                        ? JSON.stringify(row.values[column.name])
                        : JSON.stringify(
                            row.values[column.name] ?? '—',
                          ).replace(/^"|"$/gu, '')}
                    </div>
                  </td>
                ))}
                {editable ? (
                  <td className="px-4 py-2">
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={locked}
                        onClick={() => {
                          setEditing({ row, table });
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={locked}
                        onClick={() =>
                          void command.send({
                            kind: 'write',
                            tableId: table.id,
                            body: {
                              command: {
                                operation: 'delete',
                                table: table.name,
                                query: { filters: [], limit: 100, offset: 0 },
                              },
                              rowId: row.id,
                              expectedRevision: row.revision,
                            },
                          })
                        }
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.data?.rows.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            No rows match.{' '}
            {table.rowCount === 0
              ? 'Add a row or import CSV to start.'
              : 'Try a different filter.'}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Button
          type="button"
          variant="outline"
          disabled={query.offset === 0 || rows.isPending}
          onClick={() => {
            setQuery((current) => ({
              ...current,
              offset: Math.max(0, current.offset - current.limit),
            }));
          }}
        >
          Previous
        </Button>
        <span>
          Rows{' '}
          {rows.data?.rows.length === 0
            ? '0'
            : `${String(query.offset + 1)}–${String(query.offset + (rows.data?.rows.length ?? 0))}`}
        </span>
        <Button
          type="button"
          variant="outline"
          disabled={rows.data?.hasMore !== true || rows.isPending}
          onClick={() => {
            setQuery((current) => ({
              ...current,
              offset: current.offset + current.limit,
            }));
          }}
        >
          Next
        </Button>
      </div>
      {editing === undefined ? null : (
        <TableRowEditor
          scope={scope}
          table={editing.table}
          schemaChanged={
            JSON.stringify(editing.table.columns) !==
            JSON.stringify(table.columns)
          }
          row={editing.row}
          onClose={() => {
            setEditing(undefined);
          }}
        />
      )}{' '}
      {importing ? (
        <ImportTableCsv
          scope={scope}
          table={table}
          onClose={() => {
            setImporting(false);
          }}
        />
      ) : null}
    </div>
  );
}
