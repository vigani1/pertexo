import type { DataTableDefinition } from '@pertexo/contracts';
import type { DataTableQuery } from '@pertexo/node-sdk';
import { DownloadIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import type { TableScope } from '../data/tables.api';
import { useTableExport } from '../data/tables-export';

export function ExportTableRows({
  scope,
  table,
  query,
}: Readonly<{
  scope: TableScope;
  table: DataTableDefinition;
  query: DataTableQuery;
}>) {
  const exporter = useTableExport(scope, table.id);
  const { error } = exporter;
  function download({ filtered }: Readonly<{ filtered: boolean }>) {
    exporter.start({ filters: filtered ? query.filters : [] });
  }
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        title="CSV in the order rows were added"
        onClick={() => {
          download({ filtered: false });
        }}
      >
        <DownloadIcon aria-hidden="true" data-icon="inline-start" />
        {/* Icon only on a phone, so the actions keep to one row. */}
        <span className="max-sm:sr-only">Export all rows</span>
      </Button>
      {query.filters.length === 0 ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            download({ filtered: true });
          }}
        >
          Export filtered rows
        </Button>
      )}
      {error === undefined ? null : (
        <Notice tone="warning" className="basis-full">
          {error}
        </Notice>
      )}
    </>
  );
}
