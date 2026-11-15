import { sql } from 'drizzle-orm';

import { artifacts, runCheckpoints, runEvents } from '@pertexo/database/schema';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

import type { ArtifactStatus } from './artifact.js';

/** Aggregates arrive as text so a total past the safe integer range isn't rounded. */
export type CapacityAggregate = Readonly<{ bytes: string; count: string }>;

export async function readArtifactCapacityAggregates(
  transaction: WorkspaceTransaction,
): Promise<readonly (CapacityAggregate & { status: ArtifactStatus })[]> {
  return transaction.db
    .select({
      bytes: sql<string>`coalesce(sum(${artifacts.byteLength}), 0)::text`,
      count: sql<string>`count(*)::text`,
      status: artifacts.status,
    })
    .from(artifacts)
    .groupBy(artifacts.status);
}

export async function readExecutionStorageAggregates(
  transaction: WorkspaceTransaction,
): Promise<
  Readonly<{
    event: CapacityAggregate | undefined;
    checkpoint: CapacityAggregate | undefined;
  }>
> {
  const [eventRows, checkpointRows] = await Promise.all([
    transaction.db
      .select({
        bytes: sql<string>`coalesce(sum(pg_column_size(${runEvents.payload})), 0)::text`,
        count: sql<string>`count(*)::text`,
      })
      .from(runEvents),
    transaction.db
      .select({
        bytes: sql<string>`coalesce(sum(pg_column_size(${runCheckpoints.schedulerState})), 0)::text`,
        count: sql<string>`count(*)::text`,
      })
      .from(runCheckpoints),
  ]);
  return { event: eventRows[0], checkpoint: checkpointRows[0] };
}
