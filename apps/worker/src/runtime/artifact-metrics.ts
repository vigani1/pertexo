import {
  readArtifactCapacity,
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
  return observations;
}
