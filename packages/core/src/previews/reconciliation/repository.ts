import type { PreviewReconciliationStore } from './contract.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import type { DatabaseConfig } from '@pertexo/database/platform';
import { reconcilePreviewDelivery } from './deliveries.repository.js';

export function createDatabasePreviewReconciliationStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): PreviewReconciliationStore & { close(): Promise<void> } {
  const lease = acquireDatabasePool(config, runtime);
  return Object.freeze({
    reconcile: (
      input: Parameters<PreviewReconciliationStore['reconcile']>[0],
    ) => reconcilePreviewDelivery(lease.pool, input),
    close: () => lease.close(),
  });
}
