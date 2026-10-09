import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import type { DatabaseConfig } from '../../config.js';
import { reconcilePreviewDelivery } from './deliveries.js';

export interface PreviewReconciliationStore {
  reconcile(
    input: Parameters<typeof reconcilePreviewDelivery>[1],
  ): ReturnType<typeof reconcilePreviewDelivery>;
}

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
