import {
  readArtifactCapacity,
  readExecutionStorageCapacity,
  type ArtifactCapacityObservation,
  type WorkspaceDatabase,
} from '@pertexo/database/execution';
import type { TransportMetrics } from '@pertexo/observability/transport-metrics';

export async function observeWorkspaceArtifactCapacity(
  database: WorkspaceDatabase,
  metrics: TransportMetrics,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<readonly ArtifactCapacityObservation[]> {
  const transactionOptions = signal === undefined ? undefined : { signal };
  const observations = await database.withWorkspace(
    workspaceId,
    readArtifactCapacity,
    transactionOptions,
  );
  for (const observation of observations) {
    try {
      metrics.observeArtifacts(observation);
    } catch {
      // Each diagnostic sink is independent of database observation truth.
    }
  }
  const executionStorage = await database.withWorkspace(
    workspaceId,
    readExecutionStorageCapacity,
    transactionOptions,
  );
  for (const observation of executionStorage) {
    try {
      metrics.observeExecutionStorage(observation);
    } catch {
      // One diagnostic failure cannot skip the remaining observations.
    }
  }
  return observations;
}
