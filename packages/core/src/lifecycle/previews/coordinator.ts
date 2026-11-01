import type {
  PreviewRetentionArtifactStore,
  PreviewRetentionProcessResult,
  PreviewRetentionCoordinator,
  PreviewRetentionCoordinatorOptions,
} from './contract.js';
import { optionsSchema } from './input.js';
import {
  previewAttempts,
  previewRuns,
  idempotencyRecords,
  artifactLinks,
  artifacts as artifactRecords,
} from '@pertexo/database/schema';
import {
  and,
  asc,
  eq,
  exists,
  getTableName,
  lte,
  ne,
  notExists,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';

import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import { acquireDatabasePool } from '@pertexo/database/platform';
import { inRetentionTransaction } from '../retention/transaction.js';

/** Deletes a preview whose artifacts are all gone, with its attempts. */
async function removePreview(
  client: PoolClient,
  workspaceId: string,
  previewRunId: string,
): Promise<void> {
  const db = drizzle(client);
  const links = db.$with('links').as(
    db
      .delete(artifactLinks)
      .where(
        and(
          eq(artifactLinks.workspaceId, workspaceId),
          eq(artifactLinks.ownerKind, 'preview_run'),
          eq(artifactLinks.ownerId, previewRunId),
        ),
      )
      .returning({ artifactId: artifactLinks.artifactId }),
  );
  await db
    .with(links)
    .delete(artifactRecords)
    .where(
      and(
        eq(artifactRecords.workspaceId, workspaceId),
        eq(artifactRecords.status, 'deleted'),
        exists(
          db
            .select({ one: sql`1` })
            .from(links)
            .where(eq(links.artifactId, artifactRecords.id)),
        ),
      ),
    )
    .catch(rethrowQueryFailure);
  await db
    .delete(previewAttempts)
    .where(
      and(
        eq(previewAttempts.workspaceId, workspaceId),
        eq(previewAttempts.previewRunId, previewRunId),
      ),
    )
    .catch(rethrowQueryFailure);
  await db
    .delete(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.workspaceId, workspaceId),
        eq(idempotencyRecords.operation, 'preview.execute'),
        eq(idempotencyRecords.resourceId, previewRunId),
        lte(idempotencyRecords.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .catch(rethrowQueryFailure);
  await db
    .delete(previewRuns)
    .where(
      and(
        eq(previewRuns.workspaceId, workspaceId),
        eq(previewRuns.id, previewRunId),
      ),
    )
    .catch(rethrowQueryFailure);
}

/**
 * Deletes expired previews. A preview's artifacts are marked deleting, left
 * alone long enough for in-flight uploads to time out, erased outside any
 * transaction, and marked deleted; the preview goes once none remain.
 */
export function createPreviewRetentionCoordinator(
  config: DatabaseConfig,
  artifacts: PreviewRetentionArtifactStore,
  inputOptions: PreviewRetentionCoordinatorOptions = {},
  runtime?: DatabaseRuntime,
): PreviewRetentionCoordinator {
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
        return Object.freeze({ ...step, status: 'waiting' });
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
async function inWorkspace(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  // Artifact capacity is charged in the artifact's own workspace.
  await drizzle(client)
    .execute(sql`select set_config('app.workspace_id',${workspaceId},true)`)
    .catch(rethrowQueryFailure);
}

async function preparePreview(
  { pool, options }: PreviewContext,
  signal: AbortSignal | undefined,
) {
  return inRetentionTransaction(pool, options, signal, async (client) => {
    const db = drizzle(client),
      child = alias(previewRuns, 'child');
    const [preview] = await db
      .select({ id: previewRuns.id, workspaceId: previewRuns.workspaceId })
      .from(previewRuns)
      .where(
        and(
          lte(previewRuns.expiresAt, sql`clock_timestamp()`),
          sql`${previewRuns.status} in ('succeeded','failed','canceled','timed_out','outcome_unknown')`,
          notExists(
            db
              .select({ one: sql`1` })
              .from(child)
              .where(
                and(
                  eq(child.workspaceId, previewRuns.workspaceId),
                  eq(child.priorPreviewRunId, previewRuns.id),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(previewRuns.expiresAt), asc(previewRuns.id))
      .limit(1)
      .for('update', { skipLocked: true })
      .catch(rethrowQueryFailure);
    if (preview === undefined) return undefined;
    const result = {
      previewRunId: preview.id,
      workspaceId: preview.workspaceId,
    };
    await inWorkspace(client, preview.workspaceId);
    const [artifact] = await db
      .select({
        id: artifactRecords.id,
        status: artifactRecords.status,
        quiet: sql<boolean>`${artifactRecords.updatedAt}<=clock_timestamp()-make_interval(secs=>${options.artifactQuiescenceSeconds})`,
      })
      .from(artifactLinks)
      .innerJoin(
        artifactRecords,
        and(
          eq(artifactRecords.workspaceId, artifactLinks.workspaceId),
          eq(artifactRecords.id, artifactLinks.artifactId),
        ),
      )
      .where(
        and(
          eq(artifactLinks.workspaceId, preview.workspaceId),
          eq(artifactLinks.ownerKind, 'preview_run'),
          eq(artifactLinks.ownerId, preview.id),
          ne(artifactRecords.status, 'deleted'),
        ),
      )
      .orderBy(asc(artifactRecords.id))
      .limit(1)
      .for('update', {
        of: alias(artifactRecords, getTableName(artifactRecords)),
      })
      .catch(rethrowQueryFailure);
    if (artifact === undefined) {
      await removePreview(client, preview.workspaceId, preview.id);
      return { ...result, status: 'completed' as const };
    }
    if (artifact.status !== 'deleting') {
      await db
        .update(artifactRecords)
        .set({ status: 'deleting', updatedAt: sql`clock_timestamp()` })
        .where(eq(artifactRecords.id, artifact.id))
        .catch(rethrowQueryFailure);
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
    await inWorkspace(client, workspaceId);
    const db = drizzle(client);
    await db
      .update(artifactRecords)
      .set({
        status: 'deleted',
        deletedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(artifactRecords.id, artifactId),
          eq(artifactRecords.status, 'deleting'),
        ),
      )
      .catch(rethrowQueryFailure);
    const remaining = await db
      .select({ one: sql`1` })
      .from(artifactLinks)
      .innerJoin(
        artifactRecords,
        and(
          eq(artifactRecords.workspaceId, artifactLinks.workspaceId),
          eq(artifactRecords.id, artifactLinks.artifactId),
        ),
      )
      .where(
        and(
          eq(artifactLinks.workspaceId, workspaceId),
          eq(artifactLinks.ownerKind, 'preview_run'),
          eq(artifactLinks.ownerId, previewRunId),
          ne(artifactRecords.status, 'deleted'),
        ),
      )
      .limit(1)
      .catch(rethrowQueryFailure);
    if (remaining.length !== 0) return false;
    await removePreview(client, workspaceId, previewRunId);
    return true;
  });
}
