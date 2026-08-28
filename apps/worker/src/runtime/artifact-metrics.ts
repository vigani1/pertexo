import {
  readArtifactCapacity,
  readExecutionStorageCapacity,
  type ArtifactCapacityObservation,
  type WorkspaceDatabase,
} from '@pertexo/database';
import type { TransportMetrics } from '@pertexo/observability/transport-metrics';

export async function observeWorkspaceArtifactCapacity(
  database: WorkspaceDatabase,
  metrics: TransportMetrics,
  workspaceId: string,
): Promise<readonly ArtifactCapacityObservation[]> {
  const observations = await database.withWorkspace(
    workspaceId,
    readArtifactCapacity,
  );
  for (const observation of observations) {
    metrics.observeArtifacts(observation);
  }
  const executionStorage = await database.withWorkspace(
    workspaceId,
    readExecutionStorageCapacity,
  );
  for (const observation of executionStorage)
    metrics.observeExecutionStorage?.(observation);
  return observations;
}
