import { QueryView } from '@/components/patterns/states/query-view';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DataTableDefinition } from '@pertexo/contracts';
import type {
  DataTableColumn,
  DataTableQuery,
  DataTableRow,
} from '@pertexo/node-sdk';
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Skeleton } from '@/components/ui/skeleton';
import { FORMAT_LOCALE } from '@/lib/format/locale';
import { cn } from '@/lib/utils';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import { ExportTableRows } from '../transfer/export';
import {
  sendTableCommand,
  type TableScope,
  type TableCommand,
} from '../../data/tables.api';
import { tableRowsQuery, tableKeys } from '../../data/tables.queries';
import { TableRowEditor } from '../row-editor';
import { ImportTableCsv } from '../import';
import { DataTableFilters, DataTableSort } from '../filters';
import { TableCommandFeedback } from '../command-feedback';
import { tableCellText } from '../../model/values';
import { COLUMN_TYPES } from '../../model/column-types';
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
  const shown = rows.data?.rows.length ?? 0;
  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <DataTableFilters table={table} query={query} onChange={setQuery} />
        <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
          <DataTableSort table={table} query={query} onChange={setQuery} />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh rows"
            title="Refresh rows"
            onClick={() => void rows.refetch()}
          >
            {rows.isFetching ? (
              <LoadingOrb />
            ) : (
              <RefreshCwIcon aria-hidden="true" />
            )}
          </Button>
          <ExportTableRows scope={scope} table={table} query={query} />
          {editable ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setImporting(true);
                }}
              >
                <UploadIcon aria-hidden="true" data-icon="inline-start" />
                <span className="max-sm:sr-only">Import CSV</span>
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => {
                  setEditing({ table });
                }}
              >
                <PlusIcon aria-hidden="true" data-icon="inline-start" />
                Add row
              </Button>
            </>
          ) : null}
        </div>
      </div>
      <TableCommandFeedback command={command} />
      <QueryView query={rows} resource="Rows" loading={null} />
      <div className="min-w-0 overflow-hidden rounded-xl border border-surface-ink/8 bg-surface-ink/[0.015]">
        {/* Relative keeps hidden labels inside the scroller, not past the page. */}
        <div className="relative max-w-full overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{table.name} rows</caption>
            <thead className="bg-surface-ink/[0.025]">
              <tr className="border-b border-surface-ink/8">
                {table.columns.map((column) => {
                  const look = COLUMN_TYPES[column.type];
                  const Icon =
                    column.name === table.keyColumn ? KeyRoundIcon : look.icon;
                  return (
                    <th
                      key={column.name}
                      scope="col"
                      className={cn(
                        'px-4 py-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground',
                        column.type === 'number' && 'text-right',
                      )}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <Icon
                          aria-hidden="true"
                          className={cn('size-3.5', look.text)}
                        />
                        <span className="font-mono text-foreground/90">
                          {column.name}
                        </span>
                        <span className="sr-only">, {column.type}</span>
                      </span>
                    </th>
                  );
                })}
                {editable ? (
                  <th scope="col" className="w-20 px-2 py-2.5">
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.isPending
                ? Array.from({ length: 3 }, (_, index) => (
                    <tr
                      key={`loading-${String(index)}`}
                      aria-hidden="true"
                      className="border-b border-surface-ink/5 last:border-0"
                    >
                      <td
                        colSpan={table.columns.length + (editable ? 1 : 0)}
                        className="px-4 py-3"
                      >
                        <Skeleton className="h-3.5 w-full max-w-md" />
                      </td>
                    </tr>
                  ))
                : null}
              {rows.data?.rows.map((row) => (
                <tr
                  key={row.id}
                  className="group/row border-b border-surface-ink/5 transition-colors last:border-0 hover:bg-surface-ink/[0.03] motion-reduce:transition-none"
                >
                  {table.columns.map((column) => (
                    <td
                      key={column.name}
                      className={cn(
                        'max-w-72 min-w-28 px-4 py-2.5 align-top',
                        column.type === 'number' && 'text-right',
                        // A number or a day never breaks across lines.
                        (column.type === 'number' || column.type === 'date') &&
                          'whitespace-nowrap',
                      )}
                    >
                      <TableCell
                        type={column.type}
                        value={row.values[column.name]}
                      />
                    </td>
                  ))}
                  {editable ? (
                    <td className="px-2 py-1.5 align-top">
                      {/* Shown on hover or focus; always on touch screens. */}
                      <div className="flex justify-end gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Edit"
                          title="Edit row"
                          disabled={locked}
                          onClick={() => {
                            setEditing({ row, table });
                          }}
                        >
                          <PencilIcon aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Delete"
                          title="Delete row"
                          className="hover:text-destructive"
                          disabled={locked}
                          onClick={() =>
                            void command.send({
                              kind: 'write',
                              tableId: table.id,
                              body: {
                                command: {
                                  operation: 'delete',
                                  table: table.name,
                                  query: {
                                    filters: [],
                                    limit: 100,
                                    offset: 0,
                                  },
                                },
                                rowId: row.id,
                                expectedRevision: row.revision,
                              },
                            })
                          }
                        >
                          <Trash2Icon aria-hidden="true" />
                        </Button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.data?.rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No rows match.{' '}
              {table.rowCount === 0
                ? 'Add a row or import CSV to start.'
                : 'Try a different filter.'}
            </p>
          ) : null}
        </div>
        {/* The grid's own footer: where you are on the left, paging right. */}
        <div className="flex items-center justify-between gap-3 border-t border-surface-ink/8 px-4 py-2 text-xs text-muted-foreground">
          <p className="font-mono tabular-nums" aria-live="polite">
            {shown === 0
              ? 'No rows shown'
              : `Rows ${String(query.offset + 1)}–${String(query.offset + shown)}`}
            {query.filters.length === 0
              ? ` of ${table.rowCount.toLocaleString(FORMAT_LOCALE)}`
              : ' · filtered'}
          </p>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Previous rows"
              disabled={query.offset === 0 || rows.isPending}
              onClick={() => {
                setQuery((current) => ({
                  ...current,
                  offset: Math.max(0, current.offset - current.limit),
                }));
              }}
            >
              <ChevronLeftIcon aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Next rows"
              disabled={!(rows.data?.hasMore ?? false) || rows.isPending}
              onClick={() => {
                setQuery((current) => ({
                  ...current,
                  offset: current.offset + current.limit,
                }));
              }}
            >
              <ChevronRightIcon aria-hidden="true" />
            </Button>
          </div>
        </div>
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

/**
 * A cell in its type's voice: numbers and dates in mono, true and false as
 * marks, JSON as compact code, an empty cell as a faint dash.
 */
function TableCell({
  type,
  value,
}: Readonly<{ type: DataTableColumn['type']; value: unknown }>) {
  const text = tableCellText(value);
  if (text === undefined)
    return (
      <span className="text-subtle-foreground/60">
        <span aria-hidden="true">—</span>
        <span className="sr-only">Empty</span>
      </span>
    );
  if (type === 'boolean')
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 text-xs font-medium',
          value === true ? 'text-success' : 'text-muted-foreground',
        )}
      >
        {value === true ? (
          <CheckIcon aria-hidden="true" className="size-3.5" />
        ) : (
          <XIcon aria-hidden="true" className="size-3.5" />
        )}
        {text}
      </span>
    );
  if (type === 'number' || type === 'date')
    return <span className="font-mono tabular-nums">{text}</span>;
  if (type === 'json')
    return (
      <code className="line-clamp-2 font-mono text-xs break-all text-foreground/80">
        {text}
      </code>
    );
  return (
    <div className="line-clamp-4 break-words whitespace-pre-wrap">{text}</div>
  );
}
