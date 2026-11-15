import type { AuditFilter } from '@pertexo/contracts';
import { useNativeDownload } from '@/lib/api/commands/use-native-download';
import { exportAudit, type GovernanceScope } from './audit.api';

/** Starts the audit file download. */
export function useAuditExport(scope: GovernanceScope) {
  return useNativeDownload((filters: AuditFilter) => {
    exportAudit(scope, filters);
  }, 'starting the audit download');
}
