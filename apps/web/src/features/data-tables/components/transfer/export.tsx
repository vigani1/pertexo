import { useState } from 'react';
import type { DataTableDefinition } from '@pertexo/contracts';
import type { DataTableQuery } from '@pertexo/node-sdk';
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
  function download(filtered: boolean) {
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
        onClick={() => {
          download(false);
        }}
      >
        Export all rows
      </Button>
      {query.filters.length === 0 ? null : (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            download(true);
          }}
        >
          Export filtered rows
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        CSV exports use row creation order. Your browser tracks progress and
        reports interrupted downloads.
      </p>
      {error === undefined ? null : <Notice tone="warning">{error}</Notice>}
    </>
  );
}
