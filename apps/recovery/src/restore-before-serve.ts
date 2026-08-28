import { createHash } from 'node:crypto';

import type {
  DualRegionArtifactStore,
  DualRegionArtifactStoreReadiness,
  DualRegionControlLedger,
  DualRegionControlLedgerReadiness,
} from '@pertexo/artifact-store';
import type {
  ControlLedgerCoordinator,
  ControlLedgerInventoryResult,
} from '@pertexo/database';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type { MaintenanceMetrics } from '@pertexo/observability';
import type { TelemetryLifecycle } from '@pertexo/observability/telemetry';

export interface RestoreBeforeServeResources {
  readonly artifactPageSize: number;
  readonly artifacts: DualRegionArtifactStore;
  readonly coordinator: ControlLedgerCoordinator;
  readonly expectedMaintenanceRole: string;
  readonly ledger: DualRegionControlLedger;
  readonly logger: StructuredLogger;
  readonly metrics: MaintenanceMetrics;
  readonly maxArtifactPages: number;
  readonly signal: AbortSignal;
  readonly telemetry: TelemetryLifecycle;
}

export interface RestoreArtifactInventoryResult {
  readonly artifactCount: number;
  readonly inventoryDigest: string;
  readonly pageCount: number;
  readonly readiness: DualRegionArtifactStoreReadiness;
}

export interface RestoreBeforeServeResult {
  readonly artifacts: RestoreArtifactInventoryResult;
  readonly inventory: ControlLedgerInventoryResult;
  readonly ledger: DualRegionControlLedgerReadiness;
}

async function verifyArtifactInventory(
  resources: RestoreBeforeServeResources,
  readiness: DualRegionArtifactStoreReadiness,
): Promise<RestoreArtifactInventoryResult> {
  const digest = createHash('sha256');
  let afterArtifactId: string | undefined;
  let afterWorkspaceId: string | undefined;
  let artifactCount = 0;
  for (
    let pageCount = 1;
    pageCount <= resources.maxArtifactPages;
    pageCount += 1
  ) {
    resources.signal.throwIfAborted();
    const page = await resources.coordinator.listCommittedArtifacts({
      ...(afterArtifactId === undefined ? {} : { afterArtifactId }),
      ...(afterWorkspaceId === undefined ? {} : { afterWorkspaceId }),
      limit: resources.artifactPageSize,
      signal: resources.signal,
    });
    if (page.hasMore && page.artifacts.length === 0)
      throw new Error('Committed artifact inventory made no progress');
    for (const artifact of page.artifacts) {
      await resources.artifacts.verifyReplicas({
        ...artifact,
        signal: resources.signal,
      });
      digest.update(
        `${artifact.workspaceId}\0${artifact.artifactId}\0${String(artifact.byteLength)}\0${artifact.mediaType}\0${artifact.sha256}\n`,
      );
      artifactCount += 1;
      afterWorkspaceId = artifact.workspaceId;
      afterArtifactId = artifact.artifactId;
    }
    if (!page.hasMore)
      return Object.freeze({
        artifactCount,
        inventoryDigest: digest.digest('hex'),
        pageCount,
        readiness,
      });
  }
  throw new Error('Committed artifact inventory exceeded its page bound');
}

export async function restoreBeforeServe(
  resources: RestoreBeforeServeResources,
): Promise<RestoreBeforeServeResult> {
  let result: RestoreBeforeServeResult | undefined;
  let operationError: unknown;
  const startedAt = performance.now();
  try {
    resources.telemetry.start();
    resources.signal.throwIfAborted();
    await resources.coordinator.checkRestoreReadiness({
      expectedMaintenanceRole: resources.expectedMaintenanceRole,
      signal: resources.signal,
    });
    const ledger = await resources.ledger.checkReadiness(resources.signal);
    const artifactReadiness = await resources.artifacts.checkReadiness(
      resources.signal,
    );
    const inventory = await resources.coordinator.reconcileAllWorkspaces({
      signal: resources.signal,
    });
    const artifacts = await verifyArtifactInventory(
      resources,
      artifactReadiness,
    );
    result = Object.freeze({ artifacts, inventory, ledger });
    resources.metrics.recordControlLedgerReconciliation(
      'agreed',
      (performance.now() - startedAt) / 1_000,
    );
    resources.logger.info('restore_before_serve.completed', {
      inventoryDigest: inventory.inventoryDigest,
      artifactCount: artifacts.artifactCount,
      artifactInventoryDigest: artifacts.inventoryDigest,
      artifactPageCount: artifacts.pageCount,
      projectedRecordCount: inventory.projectedRecordCount,
      sweepCount: inventory.sweepCount,
      workspaceCount: inventory.workspaceCount,
    });
  } catch (error: unknown) {
    resources.metrics.recordControlLedgerReconciliation(
      'failed',
      (performance.now() - startedAt) / 1_000,
    );
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
    resources.artifacts.close();
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
