import { useState } from 'react';
import type { DataTableExportQuery } from '@pertexo/contracts';
import { describeCommandError } from '@/lib/api/error-copy';
import { exportRows, type TableScope } from './tables.api';

/** Starts a table's CSV download; a refused start reads as `error`. */
export function useTableExport(scope: TableScope, tableId: string) {
  const [error, setError] = useState<string>();
  return {
    error,
    start(query: DataTableExportQuery) {
      setError(undefined);
      try {
        exportRows(scope, tableId, query);
      } catch (cause) {
        setError(describeCommandError(cause, 'starting this download'));
      }
    },
  };
}
