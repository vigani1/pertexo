import type { DualRegionControlLedger } from '@pertexo/artifact-store';
import type {
  RetentionDatabase,
  DatabaseRuntime,
  RetentionEnforcementCoordinator,
  PreviewRetentionCoordinator,
  RunArtifactRetentionCoordinator,
  WorkspacePurgeCoordinator,
} from '@pertexo/database/maintenance';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type { TelemetryLifecycle } from '@pertexo/observability/telemetry';
import { waitForAbortableDelay } from '@pertexo/observability/runtime';

import { runMaintenanceLoops } from './maintenance-loops.js';
import type { RetentionMetrics } from './metrics.js';

export interface RetentionWorkerResources {
  readonly artifacts: { checkReadiness(): Promise<unknown>; close(): void };
  readonly database: RetentionDatabase;
  readonly databaseRuntime?: DatabaseRuntime;
  readonly enforcement: RetentionEnforcementCoordinator;
  readonly expectedMaintenanceRole: string;
  readonly logger: StructuredLogger;
  readonly ledger: DualRegionControlLedger;
  readonly metrics: RetentionMetrics;
  readonly preview: PreviewRetentionCoordinator;
  readonly runArtifacts: RunArtifactRetentionCoordinator;
  readonly workspacePurge: WorkspacePurgeCoordinator;
  readonly pollIntervalMs: number;
  readonly replicaMonitor: Readonly<{
    applicationName: string;
    sampleIntervalMs: number;
  }>;
  readonly signal: AbortSignal;
  readonly telemetry: TelemetryLifecycle;
}

export async function runRetentionWorker(
  resources: RetentionWorkerResources,
): Promise<void> {
  let operationError: unknown;
  const supervisorShutdown = new AbortController();
  const supervisorSignal = AbortSignal.any([
    resources.signal,
    supervisorShutdown.signal,
  ]);
  let supervisors: readonly Promise<void>[] = [];
  try {
    resources.telemetry.start();
    await resources.database.checkReadiness({
      expectedMaintenanceRole: resources.expectedMaintenanceRole,
      signal: resources.signal,
    });
    resources.logger.info('retention.ready');
    supervisors = [
      monitorRegionalReplicaLag(resources, supervisorSignal),
      runMaintenanceLoops(resources, supervisorSignal),
    ];
    await Promise.all(supervisors);
  } catch (error: unknown) {
    operationError = error;
  }

  supervisorShutdown.abort(new Error('Retention worker stopping'));
  const supervisorResults = await Promise.allSettled(supervisors);
  for (const result of supervisorResults)
    if (result.status === 'rejected' && operationError === undefined)
      operationError = result.reason;

  const cleanupErrors: unknown[] = [];
  for (const close of [
    () => resources.preview.close(),
    () => resources.runArtifacts.close(),
    () => resources.workspacePurge.close(),
    () => {
      resources.artifacts.close();
    },
    () => resources.enforcement.close(),
    () => resources.database.close(),
    () => resources.databaseRuntime?.close(),
    () => {
      resources.ledger.close();
    },
    () => resources.telemetry.shutdown(),
  ]) {
    await Promise.resolve()
      .then(close)
      .catch((error: unknown) => cleanupErrors.push(error));
  }
  if (operationError !== undefined || cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors].filter((error) => error !== undefined),
      'Retention worker did not stop cleanly',
    );
  }
}

async function monitorRegionalReplicaLag(
  resources: RetentionWorkerResources,
  signal: AbortSignal,
): Promise<void> {
  let previousStatus: 'open' | 'paused' | 'unavailable' | undefined;
  while (!signal.aborted) {
    try {
      const observation = await resources.database.recordRegionalReplicaLag(
        resources.replicaMonitor.applicationName,
        signal,
      );
      resources.metrics.recordRegionalReplicaLag(observation);
      if (observation.status !== previousStatus) {
        resources.logger.info('retention.regional_replica_lag', {
          replayLagMillis: observation.replayLagMillis,
          replicationState: observation.replicationState,
          status: observation.status,
        });
        previousStatus = observation.status;
      }
    } catch (error: unknown) {
      if (error === signal.reason) return;
      resources.logger.error(
        'retention.regional_replica_lag_failed',
        { applicationName: resources.replicaMonitor.applicationName },
        error,
      );
    }
    await waitForAbortableDelay(
      resources.replicaMonitor.sampleIntervalMs,
      signal,
    ).catch((error: unknown) => {
      if (!signal.aborted) throw error;
    });
  }
}
