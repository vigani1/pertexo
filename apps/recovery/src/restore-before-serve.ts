import type {
  DualRegionControlLedger,
  DualRegionControlLedgerReadiness,
} from '@pertexo/artifact-store';
import type {
  ControlLedgerCoordinator,
  ControlLedgerInventoryResult,
} from '@pertexo/database';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type { TelemetryLifecycle } from '@pertexo/observability/telemetry';

export interface RestoreBeforeServeResources {
  readonly coordinator: ControlLedgerCoordinator;
  readonly expectedMaintenanceRole: string;
  readonly ledger: DualRegionControlLedger;
  readonly logger: StructuredLogger;
  readonly signal: AbortSignal;
  readonly telemetry: TelemetryLifecycle;
}

export interface RestoreBeforeServeResult {
  readonly inventory: ControlLedgerInventoryResult;
  readonly ledger: DualRegionControlLedgerReadiness;
}

export async function restoreBeforeServe(
  resources: RestoreBeforeServeResources,
): Promise<RestoreBeforeServeResult> {
  let result: RestoreBeforeServeResult | undefined;
  let operationError: unknown;
  try {
    resources.telemetry.start();
    resources.signal.throwIfAborted();
    await resources.coordinator.checkRestoreReadiness({
      expectedMaintenanceRole: resources.expectedMaintenanceRole,
      signal: resources.signal,
    });
    const ledger = await resources.ledger.checkReadiness(resources.signal);
    const inventory = await resources.coordinator.reconcileAllWorkspaces({
      signal: resources.signal,
    });
    result = Object.freeze({ inventory, ledger });
    resources.logger.info('restore_before_serve.completed', {
      inventoryDigest: inventory.inventoryDigest,
      projectedRecordCount: inventory.projectedRecordCount,
      sweepCount: inventory.sweepCount,
      workspaceCount: inventory.workspaceCount,
    });
  } catch (error: unknown) {
    operationError = error;
    resources.logger.error(
      'restore_before_serve.failed',
      { errorType: error instanceof Error ? error.name : typeof error },
      error,
    );
  }

  const cleanupErrors: unknown[] = [];
  try {
    await resources.coordinator.close();
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }
  try {
    resources.ledger.close();
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }
  try {
    await resources.telemetry.shutdown();
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }

  if (operationError !== undefined || cleanupErrors.length > 0) {
    throw new AggregateError(
      [
        ...(operationError === undefined ? [] : [operationError]),
        ...cleanupErrors,
      ],
      'Restore-before-serve recovery did not complete cleanly',
    );
  }
  if (result === undefined)
    throw new Error('Restore-before-serve recovery produced no result');
  return result;
}
