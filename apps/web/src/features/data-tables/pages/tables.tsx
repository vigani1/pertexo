import { QueryView } from '@/components/patterns/states/query-view';
import { isAdministrativeRole } from '@pertexo/workflow-model';
import { useState } from 'react';
import { ArrowLeftIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type {
  AccessibleWorkspace,
  DataTablesResponse,
  DataTableDefinition,
} from '@pertexo/contracts';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { tablesQuery } from '../data/tables.queries';
import type { TableScope } from '../data/tables.api';
import { CreateDataTable } from '../components/create';
import { DataTableLimits } from '../components/limits';
import { DataTableRows } from '../components/rows/view';
import { EditTableColumns } from '../components/columns/dialog';
import { RemoveDataTable } from '../components/remove';
import {
  TablePageActions,
  TableCapacity,
  TableCollection,
} from '../components/overview';
import { FORMAT_LOCALE } from '@/lib/format/locale';
import { formatByteLength } from '@/lib/format/bytes';
import { ColumnChip, UsageMeter } from '../components/column-type';
type TableDialog = 'create' | 'limits' | 'remove' | 'columns';
export function DataTablesPage({
  scope,
  workspace,
  tableId,
  onOpen,
}: Readonly<{
  scope: TableScope;
  workspace: AccessibleWorkspace;
  tableId?: string | undefined;
  onOpen: (id: string | undefined) => void;
}>) {
  const query = useQuery(tablesQuery(scope));
  const [dialog, setDialog] = useState<TableDialog>();
  const editable =
    workspace.status === 'active' &&
    workspace.capabilities.includes('workflow:update');
  const admin = editable && isAdministrativeRole(workspace.role);
  const table = query.data?.tables.find((item) => item.id === tableId);
  const quotas = query.data?.quotas;
  return (
    <div className="flex min-w-0 max-w-7xl flex-col gap-6">
      <PageHeader>
        {tableId === undefined ? (
          <PageHeaderTitle>Data tables</PageHeaderTitle>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Back to all tables"
              onClick={() => {
                onOpen(undefined);
              }}
            >
              <ArrowLeftIcon aria-hidden="true" />
            </Button>
            <PageHeaderTitle className="wrap-anywhere">
              {table?.name ?? 'Data table'}
            </PageHeaderTitle>
          </div>
        )}
        <TablePageActions
          detail={tableId !== undefined}
          editable={editable}
          admin={admin}
          table={table}
          onDialog={setDialog}
        />
      </PageHeader>
      {tableId === undefined ? (
        <>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Small lookups and saved state your workflows read and write. Keep
            secrets in Connections; an exported workflow names its tables but
            never carries their rows.
          </p>
          <TableCapacity quotas={quotas} />
        </>
      ) : null}
      <QueryView query={query} resource="Data tables" />
      {tableId === undefined ? (
        <TableCollection
          tables={query.data?.tables}
          rowLimit={quotas?.rowLimit}
          workspaceId={workspace.id}
        />
      ) : (
        <TableDetail
          scope={scope}
          table={table}
          quotas={quotas}
          pending={query.isPending}
          editable={editable}
        />
      )}
      <TableDialogs
        scope={scope}
        table={table}
        quotas={quotas}
        dialog={dialog}
        onClose={() => {
          setDialog(undefined);
        }}
        onOpen={onOpen}
      />
    </div>
  );
}
function TableDetail({
  scope,
  table,
  quotas,
  pending,
  editable,
}: Readonly<{
  scope: TableScope;
  table: DataTableDefinition | undefined;
  quotas: DataTablesResponse['quotas'] | undefined;
  pending: boolean;
  editable: boolean;
}>) {
  if (table === undefined)
    return pending ? null : (
      <Notice>
        This table is unavailable. Open All tables to choose another.
      </Notice>
    );
  return (
    <>
      {/* The table's shape: its typed columns, then how full it is. */}
      <section
        aria-label="Columns and capacity"
        className="flex flex-col gap-3"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {table.columns.map((column) => (
            <ColumnChip
              key={column.name}
              column={column}
              isKey={column.name === table.keyColumn}
            />
          ))}
        </div>
        <div className="flex max-w-xl min-w-0 items-center gap-3 text-xs text-muted-foreground">
          <span className="shrink-0 font-mono tabular-nums">
            {table.rowCount.toLocaleString(FORMAT_LOCALE)}
            {quotas === undefined
              ? ''
              : ` / ${quotas.rowLimit.toLocaleString(FORMAT_LOCALE)}`}{' '}
            rows
          </span>
          {quotas === undefined ? null : (
            <UsageMeter
              used={table.rowCount}
              limit={quotas.rowLimit}
              label="Rows used"
              className="min-w-16 flex-1"
            />
          )}
          <span className="shrink-0 font-mono">
            {formatByteLength(table.storedBytes)}
          </span>
        </div>
        <p className="text-xs text-subtle-foreground">
          {table.keyColumn === null
            ? 'No unique key: rows can repeat.'
            : `Rows are unique by ${table.keyColumn}.`}{' '}
          Each row fits 64 KB.
        </p>
      </section>
      <DataTableRows
        key={table.id}
        scope={scope}
        table={table}
        editable={editable}
      />
    </>
  );
}
function TableDialogs({
  scope,
  table,
  quotas,
  dialog,
  onClose,
  onOpen,
}: Readonly<{
  scope: TableScope;
  table: DataTableDefinition | undefined;
  quotas: DataTablesResponse['quotas'] | undefined;
  dialog: TableDialog | undefined;
  onClose: () => void;
  onOpen: (id: string | undefined) => void;
}>) {
  switch (dialog) {
    case 'create':
      return quotas === undefined ? null : (
        <CreateDataTable
          scope={scope}
          columnLimit={quotas.columnLimit}
          onClose={onClose}
          onCreated={onOpen}
        />
      );
    case 'limits':
      return quotas === undefined ? null : (
        <DataTableLimits scope={scope} quotas={quotas} onClose={onClose} />
      );
    case 'columns':
      return table === undefined ? null : (
        <EditTableColumns scope={scope} table={table} onClose={onClose} />
      );
    case 'remove':
      return table === undefined ? null : (
        <RemoveDataTable
          scope={scope}
          table={table}
          onClose={onClose}
          onRemoved={() => {
            onOpen(undefined);
          }}
        />
      );
    case undefined:
    default:
      return null;
  }
}
