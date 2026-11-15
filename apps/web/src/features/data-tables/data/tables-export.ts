import type { DataTableExportQuery } from '@pertexo/contracts';
import { useNativeDownload } from '@/lib/api/commands/use-native-download';
import { exportRows, type TableScope } from './tables.api';

/** Starts a table's CSV download. */
export function useTableExport(scope: TableScope, tableId: string) {
  return useNativeDownload((query: DataTableExportQuery) => {
    exportRows(scope, tableId, query);
  }, 'starting this download');
}
