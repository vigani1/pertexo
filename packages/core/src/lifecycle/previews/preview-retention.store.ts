import { expireUnclaimedPreview } from '../../previews/attempts/expire-unclaimed-previews.repository.js';
import type { PreviewRetentionProcessResult } from './preview-retention.types.js';
import {
  optionsSchema,
  type PreviewRetentionCoordinatorOptions,
} from './preview-retention-options.schemas.js';
import {
  eraseArtifact,
  type RetentionArtifactStore,
} from '../artifacts/erase.js';
import type { Pool } from 'pg';
import type { z } from 'zod';

import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import { acquireDatabasePool } from '@pertexo/database/platform';
import { inRetentionTransaction } from '../retention/transaction.js';
import { scopeToWorkspace } from '../retention/transaction-settings.repository.js';
import {
  claimExpiredPreview,
  hasUndeletedPreviewArtifacts,
  lockPreviewArtifact,
  markPreviewArtifactDeleted,
  markPreviewArtifactDeleting,
  removePreview,
} from './expired-previews.repository.js';

export type PreviewRetentionCoordinator = ReturnType<
  typeof createPreviewRetentionCoordinator
>;

/**
 * Deletes expired previews. A preview's artifacts are marked deleting, left
 * alone long enough for in-flight uploads to time out, erased outside any
 * transaction, and marked deleted; the preview goes once none remain. No member
 * is acting, so this stays off `withWorkspaceAccess`: it runs on the maintenance
 * role.
 */
export function createPreviewRetentionCoordinator(
  config: DatabaseConfig,
  artifacts: RetentionArtifactStore,
  inputOptions: PreviewRetentionCoordinatorOptions = {},
  runtime?: DatabaseRuntime,
) {
  const options = optionsSchema.parse(inputOptions);
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;
  const context = { pool, options };

  return Object.freeze({
    close: () => lease.close(),
    processNext: async (
      signal?: AbortSignal,
    ): Promise<PreviewRetentionProcessResult> => {
      const step = await preparePreview(context, signal);
      if (step === undefined) return Object.freeze({ status: 'idle' });
      if (step.status !== 'erase') return Object.freeze(step);

      const { artifactId, previewRunId, workspaceId } = step;
      const erased = await eraseArtifact(
        pool,
        artifacts,
        { artifactId, workspaceId },
        {
          ...(signal === undefined ? {} : { signal }),
          timeoutMs: options.externalOperationTimeoutMs,
        },
      );
      if (!erased) return Object.freeze({ ...step, status: 'waiting' });
      const finished = await finishPreview(context, step, signal);
      return Object.freeze({
        artifactId,
        previewRunId,
        status: finished ? 'completed' : 'progressed',
        workspaceId,
      });
    },
  });
}

type PreviewContext = Readonly<{
  pool: Pool;
  options: z.output<typeof optionsSchema>;
}>;
async function preparePreview(
  { pool, options }: PreviewContext,
  signal: AbortSignal | undefined,
) {
  return inRetentionTransaction(pool, options, signal, async (client) => {
    const expired = await expireUnclaimedPreview(client);
    if (expired !== undefined) return expired;
    const preview = await claimExpiredPreview(client);
    if (preview === undefined) return undefined;
    const result = {
      previewRunId: preview.id,
      workspaceId: preview.workspaceId,
    };
    await scopeToWorkspace(client, preview.workspaceId);
    const artifact = await lockPreviewArtifact(
      client,
      result,
      options.artifactQuiescenceSeconds,
    );
    if (artifact === undefined) {
      await removePreview(client, preview.workspaceId, preview.id);
      return { ...result, status: 'completed' as const };
    }
    if (artifact.status !== 'deleting') {
      await markPreviewArtifactDeleting(client, artifact.id);
      return {
        ...result,
        artifactId: artifact.id,
        status: 'waiting' as const,
      };
    }
    // Uploads still in flight must time out before their bytes go.
    if (!artifact.quiet)
      return {
        ...result,
        artifactId: artifact.id,
        status: 'waiting' as const,
      };
    return { ...result, artifactId: artifact.id, status: 'erase' as const };
  });
}

async function finishPreview(
  { pool, options }: PreviewContext,
  step: Readonly<{
    artifactId: string;
    previewRunId: string;
    workspaceId: string;
  }>,
  signal: AbortSignal | undefined,
) {
  const { artifactId, previewRunId, workspaceId } = step;
  return inRetentionTransaction(pool, options, signal, async (client) => {
    await scopeToWorkspace(client, workspaceId);
    await markPreviewArtifactDeleted(client, artifactId);
    if (await hasUndeletedPreviewArtifacts(client, step)) return false;
    await removePreview(client, workspaceId, previewRunId);
    return true;
  });
}
