import { useState } from 'react';
import type { AuditFilter } from '@pertexo/contracts';
import { describeCommandError } from '@/lib/api/error-copy';
import { exportAudit, type GovernanceScope } from './audit.api';

/** Starts the audit file download; a refused start reads as `error`. */
export function useAuditExport(scope: GovernanceScope) {
  const [error, setError] = useState<string>();
  return {
    error,
    start(filters: AuditFilter) {
      setError(undefined);
      try {
        exportAudit(scope, filters);
      } catch (cause) {
        setError(describeCommandError(cause, 'starting the audit download'));
      }
    },
  };
}
