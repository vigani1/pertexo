import type { PreviewReconciliationStore } from './contract.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import type { DatabaseConfig } from '../../config.js';
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
