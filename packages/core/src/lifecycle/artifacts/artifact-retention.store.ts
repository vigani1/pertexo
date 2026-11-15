import type { RunArtifactRetentionProcessResult } from './artifact-retention.types.js';
import {
  optionsSchema,
  type RunArtifactRetentionCoordinatorOptions,
} from './artifact-retention-options.schemas.js';
import { eraseArtifact, type RetentionArtifactStore } from './erase.js';
import type { PoolClient } from 'pg';

import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import { acquireDatabasePool } from '@pertexo/database/platform';
import { inRetentionTransaction } from '../retention/transaction.js';
import { scopeToWorkspace } from '../retention/transaction-settings.repository.js';
import {
  claimExpiredArtifact,
  deferReferencedArtifact,
  deleteErasedArtifact,
  isArtifactReferenced,
  markArtifactDeleting,
} from './expired-artifacts.repository.js';

export type RunArtifactRetentionCoordinator = ReturnType<
  typeof createRunArtifactRetentionCoordinator
>;

/**
 * Deletes expired run artifacts and abandoned uploads: the artifact is marked
 * deleting, its bytes are erased outside any transaction, and its row goes
 * once the store no longer has them. No member is acting, so this stays off
 * `withWorkspaceAccess`: it runs on the maintenance role.
 */
export function createRunArtifactRetentionCoordinator(
  config: DatabaseConfig,
  artifacts: RetentionArtifactStore,
  inputOptions: RunArtifactRetentionCoordinatorOptions = {},
  runtime?: DatabaseRuntime,
) {
  const options = optionsSchema.parse(inputOptions);
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;
  const transaction = <T>(
    signal: AbortSignal | undefined,
    workspaceId: string | undefined,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> =>
    inRetentionTransaction(pool, options, signal, async (client) => {
      // Artifact capacity is charged in the artifact's own workspace.
      if (workspaceId !== undefined)
        await scopeToWorkspace(client, workspaceId);
      return work(client);
    });

  return Object.freeze({
    close: () => lease.close(),
    processNext: async (
      signal?: AbortSignal,
    ): Promise<RunArtifactRetentionProcessResult> => {
      const prepared = await transaction(signal, undefined, async (client) => {
        const artifact = await claimExpiredArtifact(client);
        if (artifact === undefined) return undefined;
        await scopeToWorkspace(client, artifact.workspaceId);
        if (await isArtifactReferenced(client, artifact)) {
          await deferReferencedArtifact(client, artifact.id);
          return { ...artifact, referenced: true };
        }
        await markArtifactDeleting(client, artifact.id);
        return { ...artifact, referenced: false };
      });
      if (prepared === undefined) return Object.freeze({ status: 'idle' });
      const artifactId = prepared.id;
      const workspaceId = prepared.workspaceId;
      if (prepared.referenced)
        return Object.freeze({ artifactId, status: 'referenced', workspaceId });

      const erased = await eraseArtifact(
        pool,
        artifacts,
        { artifactId, workspaceId },
        {
          ...(signal === undefined ? {} : { signal }),
          timeoutMs: options.externalOperationTimeoutMs,
        },
      );
      if (!erased)
        // The retry time brings it back.
        return Object.freeze({ artifactId, status: 'waiting', workspaceId });

      await transaction(signal, workspaceId, (client) =>
        deleteErasedArtifact(client, artifactId),
      );
      return Object.freeze({ artifactId, status: 'completed', workspaceId });
    },
  });
}
