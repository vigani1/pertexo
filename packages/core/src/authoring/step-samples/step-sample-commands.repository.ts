import { SECOND_INTERVAL } from '../../shared/sql-intervals.repository.js';

import { rethrowQueryFailure } from '@pertexo/database/primitives';

import { and, eq, sql } from 'drizzle-orm';

import { drizzle } from 'drizzle-orm/node-postgres';

import { workflowStepSamples } from '@pertexo/database/schema';

import type { PoolClient } from 'pg';

import { DATA_RETENTION_DAYS } from '@pertexo/workflow-model';

import { sampleProjection } from './step-sample-state.repository.js';

import type { CapturedSample } from './capture-source.js';

import type { SampleCommand } from './step-sample.types.js';

const SAMPLE_RETENTION_SECONDS = DATA_RETENTION_DAYS.stepSamples * 86_400;

/** Serializes sample writes in the workspace, then locks the step's current sample. */
export async function lockCurrentSample(
  client: PoolClient,
  input: SampleCommand,
) {
  const db = drizzle(client);
  await db
    .execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`workflow-step-sample-quota:${input.workspaceId}`},0))`,
    )
    .catch(rethrowQueryFailure);
  const [current] = await db
    .select(sampleProjection)
    .from(workflowStepSamples)
    .where(
      and(
        eq(workflowStepSamples.workspaceId, input.workspaceId),
        eq(workflowStepSamples.workflowId, input.workflowId),
        eq(workflowStepSamples.nodeId, input.nodeId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  return current;
}

export async function deleteSample(
  client: PoolClient,
  workspaceId: string,
  sampleId: string,
): Promise<void> {
  const db = drizzle(client);
  await db
    .delete(workflowStepSamples)
    .where(
      and(
        eq(workflowStepSamples.workspaceId, workspaceId),
        eq(workflowStepSamples.id, sampleId),
      ),
    )
    .catch(rethrowQueryFailure);
}

/** The workspace's retained sample bytes and counts. */
export async function readSampleUsage(
  client: PoolClient,
  input: SampleCommand,
) {
  const [usage] = await drizzle(client)
    .select({
      bytes: sql<number>`coalesce(sum(${workflowStepSamples.retainedBytes}),0)::float8`,
      workspaceCount: sql<number>`count(*)::int`,
      workflowCount: sql<number>`count(*) filter(where ${workflowStepSamples.workflowId}=${input.workflowId})::int`,
    })
    .from(workflowStepSamples)
    .where(eq(workflowStepSamples.workspaceId, input.workspaceId))
    .catch(rethrowQueryFailure);
  return usage;
}

/** Stores the captured sample, replacing the step's earlier one. */
export async function saveSample(
  client: PoolClient,
  input: SampleCommand,
  {
    sampleId,
    binding,
    captured,
    retainedBytes,
  }: Readonly<{
    sampleId: string;
    binding: string;
    captured: CapturedSample;
    retainedBytes: number;
  }>,
): Promise<void> {
  const values = {
    id: sampleId,
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
    nodeId: input.nodeId,
    binding,
    outputRef: captured.output,
    retainedBytes,
    sourceKind: captured.kind,
    sourceRunId: captured.runId,
    sourceNodeRunId: captured.nodeRunId,
    sourcePreviewId: captured.previewId,
    createdBy: input.actorId,
    expiresAt: sql<Date>`clock_timestamp()+${SAMPLE_RETENTION_SECONDS}::integer*${SECOND_INTERVAL}`,
  };
  const updates = {
    id: values.id,
    binding: values.binding,
    outputRef: values.outputRef,
    retainedBytes: values.retainedBytes,
    sourceKind: values.sourceKind,
    sourceRunId: values.sourceRunId,
    sourceNodeRunId: values.sourceNodeRunId,
    sourcePreviewId: values.sourcePreviewId,
    createdBy: values.createdBy,
    expiresAt: sql<Date>`excluded.expires_at`,
  };
  await drizzle(client)
    .insert(workflowStepSamples)
    .values(values)
    .onConflictDoUpdate({
      target: [
        workflowStepSamples.workspaceId,
        workflowStepSamples.workflowId,
        workflowStepSamples.nodeId,
      ],
      set: { ...updates, createdAt: sql`clock_timestamp()` },
    })
    .catch(rethrowQueryFailure);
}
