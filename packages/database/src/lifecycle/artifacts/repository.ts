import type {
  RunArtifactRetentionStore,
  RunArtifactRetentionProcessResult,
  RunArtifactRetentionCoordinator,
  RunArtifactRetentionCoordinatorOptions,
} from './contract.js';
import { optionsSchema } from './input.js';
import { and, asc, eq, isNull, lte, notExists, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { artifacts as artifactRecords } from '../../schema/transport.js';
import { artifactLinks } from '../../schema/runs/support.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { artifactReferenceOwnersSql } from '../../artifacts/references/owners.queries.js';
import type { PoolClient } from 'pg';

import type { DatabaseConfig } from '../../config.js';
import { acquireDatabasePool } from '../../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../../platform/pool/runtime.js';
import { inRetentionTransaction } from '../retention/transactions.repository.js';

async function retryLater(
  client: PoolClient,
  artifactId: string,
  delay: string,
): Promise<void> {
  await drizzle(client)
    .update(artifactRecords)
    .set({
      retentionRetryAt: sql`clock_timestamp()+${delay}::interval`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(artifactRecords.id, artifactId))
    .catch(rethrowQueryFailure);
}

/**
 * Deletes expired run artifacts and abandoned uploads: the artifact is marked
 * deleting, its bytes are erased outside any transaction, and its row goes
 * once the store no longer has them.
 */
export function createRunArtifactRetentionCoordinator(
  config: DatabaseConfig,
  artifacts: RunArtifactRetentionStore,
  inputOptions: RunArtifactRetentionCoordinatorOptions = {},
  runtime?: DatabaseRuntime,
): RunArtifactRetentionCoordinator {
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
        await drizzle(client)
          .execute(
            sql`select set_config('app.workspace_id',${workspaceId},true)`,
          )
          .catch(rethrowQueryFailure);
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
                  eq(artifactRecords.purpose, 'user-upload'),
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
        await db
          .execute(
            sql`select set_config('app.workspace_id',${artifact.workspaceId},true)`,
          )
          .catch(rethrowQueryFailure);
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
          await retryLater(client, artifact.id, '1 day');
          return { ...artifact, referenced: true };
        }
        await db
          .update(artifactRecords)
          .set({
            status: 'deleting',
            retentionRetryAt: sql`clock_timestamp()+interval '1 minute'`,
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

      const external = AbortSignal.any([
        ...(signal === undefined ? [] : [signal]),
        AbortSignal.timeout(options.externalOperationTimeoutMs),
      ]);
      await artifacts.delete({ artifactId, signal: external, workspaceId });
      if (
        (await artifacts.head({
          artifactId,
          signal: external,
          workspaceId,
        })) !== null
      )
        // The store still has the bytes; the retry time brings it back.
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
