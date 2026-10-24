import { useState } from 'react';
import type { DataTableDefinition } from '@pertexo/contracts';
import type { DataTableQuery } from '@pertexo/node-sdk';
import { DownloadIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { describeCommandError } from '@/lib/api/error-copy';
import { exportRows, type TableScope } from '../../data/tables.api';

export function ExportTableRows({
  scope,
  table,
  query,
}: Readonly<{
  scope: TableScope;
  table: DataTableDefinition;
  query: DataTableQuery;
}>) {
  const [error, setError] = useState<string>();
  function download({ filtered }: Readonly<{ filtered: boolean }>) {
    setError(undefined);
    try {
      exportRows(scope, table.id, { filters: filtered ? query.filters : [] });
    } catch (cause) {
      setError(describeCommandError(cause, 'starting this download'));
    }
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
