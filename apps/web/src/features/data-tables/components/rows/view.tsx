import { QueryView } from '@/components/patterns/states/query-view';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DataTableDefinition } from '@pertexo/contracts';
import type { DataTableQuery, DataTableRow } from '@pertexo/node-sdk';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import {
  sendTableCommand,
  type TableScope,
  type TableCommand,
} from '../../data/tables.api';
import { tableRowsQuery, tableKeys } from '../../data/tables.queries';
import { TableRowEditor } from '../row-editor';
import { ImportTableCsv } from '../import';
import { TableCommandFeedback } from '../command-feedback';
import { RowsToolbar } from './toolbar';
import { RowsGrid } from './grid';
import { RowsPager } from './pager';

type RowEdit = Readonly<{ row?: DataTableRow; table: DataTableDefinition }>;

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
  const [editing, setEditing] = useState<RowEdit>();
  const [importing, setImporting] = useState(false);
  const rows = useQuery(tableRowsQuery(scope, table.id, query));
  const command = useRetainedCommand(
    (body: TableCommand, key: string) => sendTableCommand(scope, body, key),
    async () => {
      await cache.invalidateQueries({ queryKey: tableKeys.scope(scope) });
    },
    { action: 'deleting this row' },
  );
  function deleteRow(row: DataTableRow) {
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
    });
  }
  const locked = command.pending || command.uncertain;
  const shown = rows.data?.rows.length ?? 0;
  return (
    <div className="grid min-w-0 gap-3">
      <RowsToolbar
        scope={scope}
        table={table}
        query={query}
        onChange={setQuery}
        refreshing={rows.isFetching}
        onRefresh={() => void rows.refetch()}
        editable={editable}
        onCreate={{
          importCsv: () => {
            setImporting(true);
          },
          addRow: () => {
            setEditing({ table });
          },
        }}
      />
      <TableCommandFeedback command={command} />
      <QueryView query={rows} resource="Rows" loading={null} />
      <div className="min-w-0 overflow-hidden rounded-xl border border-surface-ink/8 bg-surface-ink/[0.015]">
        {/* Relative keeps hidden labels inside the scroller, not past the page. */}
        <RowsGrid
          table={table}
          page={rows.data}
          pending={rows.isPending}
          editable={editable}
          locked={locked}
          onEdit={(row) => {
            setEditing({ row, table });
          }}
          onDelete={deleteRow}
        />
        {/* The grid's own footer: where you are on the left, paging right. */}
        <RowsPager
          table={table}
          query={query}
          shown={shown}
          pending={rows.isPending}
          hasMore={rows.data?.hasMore ?? false}
          onPrevious={() => {
            setQuery((current) => ({
              ...current,
              offset: Math.max(0, current.offset - current.limit),
            }));
          }}
          onNext={() => {
            setQuery((current) => ({
              ...current,
              offset: current.offset + current.limit,
            }));
          }}
        />
      </div>
      <RowsDialogs
        scope={scope}
        table={table}
        editing={editing}
        importing={importing}
        onEditingClose={() => {
          setEditing(undefined);
        }}
        onImportClose={() => {
          setImporting(false);
        }}
      />
    </div>
  );
}

function RowsDialogs({
  scope,
  table,
  editing,
  importing,
  onEditingClose,
  onImportClose,
}: Readonly<{
  scope: TableScope;
  table: DataTableDefinition;
  editing: RowEdit | undefined;
  importing: boolean;
  onEditingClose: () => void;
  onImportClose: () => void;
}>) {
  return (
    <>
      {editing === undefined ? null : (
        <TableRowEditor
          scope={scope}
          table={editing.table}
          schemaChanged={
            JSON.stringify(editing.table.columns) !==
            JSON.stringify(table.columns)
          }
          row={editing.row}
          onClose={onEditingClose}
        />
      )}{' '}
      {importing ? (
        <ImportTableCsv scope={scope} table={table} onClose={onImportClose} />
      ) : null}
    </>
  );
}
