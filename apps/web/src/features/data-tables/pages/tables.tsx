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
import { DataTableRows } from '../components/rows';
import { EditTableColumns } from '../components/columns/dialog';
import { RemoveDataTable } from '../components/remove';
import {
  TablePageActions,
  TableCapacity,
  TableCollection,
} from '../components/overview';
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
  const admin = editable && ['owner', 'admin'].includes(workspace.role);
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
            <PageHeaderTitle className="truncate">
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
          <TableCapacity quotas={quotas} />
          <p className="text-sm text-muted-foreground">
            Small lookups and saved state your workflows read and write. Keep
            secrets in Connections; an exported workflow names its tables but
            never carries their rows.
          </p>
        </>
      ) : null}
      {query.isPending ? <p role="status">Loading data tables…</p> : null}
      {query.isError ? (
        <Notice
          tone="warning"
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => void query.refetch()}
            >
              Refresh tables
            </Button>
          }
        >
          Data tables could not be loaded.
        </Notice>
      ) : null}
      {tableId === undefined ? (
        <TableCollection
          tables={query.data?.tables}
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
      <p className="text-sm text-muted-foreground">
        {table.rowCount.toLocaleString()} / {quotas?.rowLimit.toLocaleString()}{' '}
        rows ·{' '}
        {table.keyColumn === null
          ? 'No unique key'
          : `Unique key: ${table.keyColumn}`}
        . Each row fits 64 KB.
      </p>
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
    default:
      return null;
  }
}
