import type { WorkflowActor } from '../../shared/access/workflow-actor.types.js';
import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflowStepSamples,
  workflowTestSnapshots,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import { normalizedJson } from '@pertexo/workflow-model';
import type { TestSnapshot } from './load-snapshot.js';

/** Share-locks the workflow's step samples in node order. */
export async function lockWorkflowSamples(
  client: PoolClient,
  input: WorkflowActor,
) {
  const db = drizzle(client);
  const samples = await db
    .select()
    .from(workflowStepSamples)
    .where(
      and(
        eq(workflowStepSamples.workspaceId, input.workspaceId),
        eq(workflowStepSamples.workflowId, input.workflowId),
      ),
    )
    .orderBy(asc(workflowStepSamples.nodeId))
    .for('share')
    .catch(rethrowQueryFailure);
  return samples;
}

/** One immutable source may serve a standalone test or all serial suite cases. */
export async function saveTestSnapshot(
  client: PoolClient,
  input: WorkflowActor,
  {
    id,
    snapshot,
    expiresAt,
  }: Readonly<{
    id: string;
    snapshot: TestSnapshot;
    expiresAt: Date;
  }>,
): Promise<void> {
  await drizzle(client)
    .insert(workflowTestSnapshots)
    .values({
      id,
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      draftRevision: snapshot.preparation.draftRevision,
      graphJson: sql`${normalizedJson(snapshot.graph)}::json`,
      executableJson: sql`${normalizedJson(snapshot.compiled.executableJson)}::json`,
      pins: sql`${normalizedJson(snapshot.frozenPins)}::json`,
      expiresAt,
      checksum: snapshot.compiled.checksum,
      dispositions: sql`${JSON.stringify(snapshot.compiled.dispositions)}::jsonb`,
    })
    .catch(rethrowQueryFailure);
}

/** A test snapshot lives at least until this run's retention ends. */
export async function extendTestSnapshotRetention(
  client: PoolClient,
  snapshot: Readonly<{ workspaceId: string; snapshotId: string }>,
  until: Date,
): Promise<void> {
  await drizzle(client)
    .update(workflowTestSnapshots)
    .set({
      expiresAt: sql`greatest(${workflowTestSnapshots.expiresAt},${until})`,
    })
    .where(
      and(
        eq(workflowTestSnapshots.workspaceId, snapshot.workspaceId),
        eq(workflowTestSnapshots.id, snapshot.snapshotId),
      ),
    )
    .catch(rethrowQueryFailure);
}
