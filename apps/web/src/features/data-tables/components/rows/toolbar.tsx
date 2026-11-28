import type { DataTableDefinition } from '@pertexo/contracts';
import type { DataTableQuery } from '@pertexo/node-sdk';
import { PlusIcon, RefreshCwIcon, UploadIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ProgressIconButton } from '@/components/ui/progress-button';
import { ExportTableRows } from '../export-table';
import type { TableScope } from '../../data/tables.api';
import { DataTableFilters, DataTableSort } from '../filters';

export function RowsToolbar({
  scope,
  table,
  query,
  onChange,
  refreshing,
  onRefresh,
  editable,
  onCreate,
}: Readonly<{
  scope: TableScope;
  table: DataTableDefinition;
  query: DataTableQuery;
  onChange: (query: DataTableQuery) => void;
  refreshing: boolean;
  onRefresh: () => void;
  editable: boolean;
  onCreate: Readonly<{ importCsv: () => void; addRow: () => void }>;
}>) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <DataTableFilters table={table} query={query} onChange={onChange} />
      <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
        <DataTableSort table={table} query={query} onChange={onChange} />
        <ProgressIconButton
          type="button"
          variant="ghost"
          size="icon-sm"
          label="Refresh rows"
          pending={refreshing}
          onClick={onRefresh}
          icon={<RefreshCwIcon aria-hidden="true" />}
        />
        {editable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              onCreate.importCsv();
            }}
          >
            <UploadIcon aria-hidden="true" data-icon="inline-start" />
            <span className="max-sm:sr-only">Import CSV</span>
          </Button>
        ) : null}
        <ExportTableRows scope={scope} table={table} query={query} />
        {editable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              onCreate.addRow();
            }}
          >
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            Add row
          </Button>
        ) : null}
      </div>
    </div>
  );
}
