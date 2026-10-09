import { createArtifactStore } from '@pertexo/artifact-store';
import { createDatabaseRuntime } from '@pertexo/database/platform';
import {
  createPreviewRetentionCoordinator,
  createRetentionDatabase,
  createRunArtifactRetentionCoordinator,
  createWorkspacePurgeCoordinator,
} from '@pertexo/database/lifecycle';
import type { StructuredLogger } from '@pertexo/observability';

import type { WorkerConfig } from '../config/worker.js';
import { createRetentionMetrics } from './metrics.js';
import { createRetentionRuntime, type RetentionRuntime } from './runtime.js';

const RETENTION_POLL_MILLIS = 1_000;

export function configuredRetentionRuntime(
  config: WorkerConfig,
  logger: StructuredLogger,
): RetentionRuntime | undefined {
  const { artifactStore, retention } = config;
  if (retention === undefined || artifactStore === undefined) return undefined;
  const databaseRuntime = createDatabaseRuntime(retention.maintenanceDatabase, {
    role: 'maintenance',
  });
  const artifacts = createArtifactStore(artifactStore);
  const database = retention.maintenanceDatabase;
  const release = async (): Promise<void> => {
    artifacts.close();
    await databaseRuntime.close();
  };
  try {
    return createRetentionRuntime(
      {
        database: createRetentionDatabase(database, {}, databaseRuntime),
        preview: createPreviewRetentionCoordinator(
          database,
          artifacts,
          {
            // Uploads still in flight must time out before their bytes go.
            artifactQuiescenceSeconds: Math.min(
              120,
              Math.ceil(artifactStore.requestTimeoutMs / 1_000) + 1,
            ),
          },
          databaseRuntime,
        ),
        runArtifacts: createRunArtifactRetentionCoordinator(
          database,
          artifacts,
          {},
          databaseRuntime,
        ),
        workspacePurge: createWorkspacePurgeCoordinator(
          database,
          artifacts,
          {},
          databaseRuntime,
        ),
        release,
      },
      createRetentionMetrics(),
      logger,
      RETENTION_POLL_MILLIS,
    );
  } catch (error: unknown) {
    void release().catch(() => undefined);
    throw error;
  }
}
