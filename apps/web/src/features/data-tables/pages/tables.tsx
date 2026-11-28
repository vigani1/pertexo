import { UnavailableDataTable } from '../components/unavailable';
import { QueryView } from '@/components/patterns/states/query-view';
import { shownData } from '@/lib/api/error-copy';
import { isAdministrativeRole } from '@pertexo/policy';
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  AccessibleWorkspace,
  DataTablesResponse,
  DataTableDefinition,
} from '@pertexo/contracts';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { Notice } from '@/components/patterns/notices/inline-notice';
import { tablesQuery } from '../data/tables.queries';
import type { TableScope } from '../data/tables.api';
import { CreateDataTable } from '../components/create';
import { DataTableLimits } from '../components/limits';
import { DataTableRows } from '../components/rows/table-rows';
import { EditTableColumns } from '../components/columns/dialog';
import { RemoveDataTable } from '../components/remove';
import {
  TableActions,
  TableList,
  WorkspaceTableActions,
} from '../components/overview';
import { ListDetail } from '@/components/patterns/lists/list-detail';
import { formatCount } from '@/lib/format/count';
import { FORMAT_LOCALE } from '@/lib/format/locale';
import { formatByteLength } from '@/lib/format/bytes';
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
  // Definitions a refresh says are no longer readable leave the page.
  const data = shownData(query);
  // Wide screens show the first table until one is chosen.
  const shownId = tableId ?? data?.tables[0]?.id;
  const table = data?.tables.find((item) => item.id === shownId);
  const unavailable = data?.unavailableTables?.find(
    (item) => item.id === tableId,
  );
  const quotas = data?.quotas;
  return (
    <div className="flex min-w-0 max-w-300 flex-col gap-10">
      <PageHeader>
        <div className="flex flex-col gap-3">
          <PageHeaderTitle>Data tables</PageHeaderTitle>
          <p className="max-w-[60ch] text-sm text-muted-foreground">
            Small lookups and saved state your workflows read and write. Keep
            secrets in Connections; an exported workflow names its tables but
            never carries their rows.
          </p>
        </div>
        <WorkspaceTableActions
          editable={editable}
          admin={admin}
          onDialog={setDialog}
        />
      </PageHeader>
      <QueryView query={query} resource="Data tables" />
      {data === undefined ? null : (
        <ListDetail
          showing={tableId === undefined ? 'list' : 'detail'}
          backLabel="All tables"
          onBack={() => {
            onOpen(undefined);
          }}
          className="min-[56.25rem]:grid-cols-[16.25rem_minmax(0,1fr)] min-[56.25rem]:gap-12"
          list={
            <TableList
              tables={data.tables}
              unavailableTables={data.unavailableTables}
              quotas={quotas}
              selectedId={shownId}
              workspaceId={workspace.id}
            />
          }
          detail={
            shownId === undefined && unavailable === undefined ? null : (
              <TableDetail
                unavailableName={unavailable?.name}
                scope={scope}
                table={table}
                quotas={quotas}
                pending={query.isPending}
                editable={editable}
                actions={
                  table === undefined || !editable ? null : (
                    <TableActions onDialog={setDialog} />
                  )
                }
              />
            )
          }
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
  unavailableName,
  quotas,
  pending,
  editable,
  actions,
}: Readonly<{
  scope: TableScope;
  table: DataTableDefinition | undefined;
  unavailableName: string | undefined;
  quotas: DataTablesResponse['quotas'] | undefined;
  pending: boolean;
  editable: boolean;
  actions: ReactNode;
}>) {
  if (unavailableName !== undefined)
    return <UnavailableDataTable name={unavailableName} />;
  if (table === undefined)
    return pending ? null : (
      <Notice>
        This table is unavailable. Open All tables to choose another.
      </Notice>
    );
  return (
    <section
      aria-labelledby="table-name"
      className="flex min-w-0 flex-col gap-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2
            id="table-name"
            className="font-heading text-2xl font-semibold wrap-anywhere"
          >
            {table.name}
          </h2>
          <p className="mt-1.5 font-mono text-caption text-subtle-foreground">
            {table.rowCount.toLocaleString(FORMAT_LOCALE)}
            {quotas === undefined
              ? ''
              : ` of ${quotas.rowLimit.toLocaleString(FORMAT_LOCALE)}`}{' '}
            rows · {formatCount(table.columns.length, 'column')} ·{' '}
            {formatByteLength(table.storedBytes)} ·{' '}
            {table.keyColumn === null
              ? 'no unique key'
              : `unique by ${table.keyColumn}`}
          </p>
        </div>
        {actions}
      </div>
      <DataTableRows
        key={table.id}
        scope={scope}
        table={table}
        editable={editable}
      />
    </section>
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
