import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import type { DatabaseConfig } from '@pertexo/database/platform';
import type { ReconcilePreviewDeliveryInput } from './contract.js';
import { reconcilePreviewDelivery } from './reconcile.js';

/** Maintenance has no member behind it, so this stays off withWorkspaceAccess. */
export function createPreviewReconciliationStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  return Object.freeze({
    reconcile: (input: ReconcilePreviewDeliveryInput) =>
      reconcilePreviewDelivery(lease.pool, input),
    close: () => lease.close(),
  });
}
