import type { RunArtifactRetentionProcessResult } from './contract.js';
import {
  optionsSchema,
  type RunArtifactRetentionCoordinatorOptions,
} from './input.js';
import { eraseArtifact, type RetentionArtifactStore } from './erase.js';
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  artifacts as artifactRecords,
  artifactLinks,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { artifactReferenceOwnersSql } from '../../artifacts/references/owners.queries.js';
import type { PoolClient } from 'pg';

import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import { acquireDatabasePool } from '@pertexo/database/platform';
import {
  inRetentionTransaction,
  scopeToWorkspace,
} from '../retention/transaction.js';

/** Something still refers to it, so it's looked at again much later. */
const REFERENCED_RETRY = sql`interval '1 day'`;
/** Long enough for this worker to erase it; another takes over after that. */
const ERASE_RETRY = sql`interval '1 minute'`;

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
        const db = drizzle(client);
        const [artifact] = await db
          .select({
            id: artifactRecords.id,
            workspaceId: artifactRecords.workspaceId,
          })
          .from(artifactRecords)
          .where(
            and(
              or(
                and(
                  eq(artifactRecords.status, 'pending'),
                  inArray(artifactRecords.purpose, [
                    'user-upload',
                    'form-upload',
                  ]),
                  lte(artifactRecords.expiresAt, sql`clock_timestamp()`),
                ),
                and(
                  eq(artifactRecords.status, 'available'),
                  lte(artifactRecords.expiresAt, sql`clock_timestamp()`),
                ),
                eq(artifactRecords.status, 'deleting'),
              ),
              or(
                isNull(artifactRecords.retentionRetryAt),
                lte(artifactRecords.retentionRetryAt, sql`clock_timestamp()`),
              ),
              notExists(
                db
                  .select({ one: sql`1` })
                  .from(artifactLinks)
                  .where(
                    and(
                      eq(
                        artifactLinks.workspaceId,
                        artifactRecords.workspaceId,
                      ),
                      eq(artifactLinks.artifactId, artifactRecords.id),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(asc(artifactRecords.expiresAt), asc(artifactRecords.id))
          .limit(1)
          .for('update', { skipLocked: true })
          .catch(rethrowQueryFailure);
        if (artifact === undefined) return undefined;
        await scopeToWorkspace(client, artifact.workspaceId);
        const [reference] = await db
          .select({
            referenced: sql<boolean>`(${artifactReferenceOwnersSql(sql`${artifact.workspaceId}`, sql`${artifact.id}`)})`,
          })
          .from(artifactRecords)
          .where(
            and(
              eq(artifactRecords.workspaceId, artifact.workspaceId),
              eq(artifactRecords.id, artifact.id),
            ),
          )
          .catch(rethrowQueryFailure);
        if (reference?.referenced ?? false) {
          await db
            .update(artifactRecords)
            .set({
              retentionRetryAt: sql`clock_timestamp()+${REFERENCED_RETRY}`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(artifactRecords.id, artifact.id))
            .catch(rethrowQueryFailure);
          return { ...artifact, referenced: true };
        }
        await db
          .update(artifactRecords)
          .set({
            status: 'deleting',
            retentionRetryAt: sql`clock_timestamp()+${ERASE_RETRY}`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(artifactRecords.id, artifact.id))
          .catch(rethrowQueryFailure);
        return { ...artifact, referenced: false };
      });
      if (prepared === undefined) return Object.freeze({ status: 'idle' });
      const artifactId = prepared.id;
      const workspaceId = prepared.workspaceId;
      if (prepared.referenced)
        return Object.freeze({ artifactId, status: 'referenced', workspaceId });

      const erased = await eraseArtifact(
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
        drizzle(client)
          .delete(artifactRecords)
          .where(
            and(
              eq(artifactRecords.id, artifactId),
              eq(artifactRecords.status, 'deleting'),
            ),
          )
          .catch(rethrowQueryFailure),
      );
      return Object.freeze({ artifactId, status: 'completed', workspaceId });
    },
  });
}
