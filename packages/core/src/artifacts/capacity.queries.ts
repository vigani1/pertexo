import { sql } from 'drizzle-orm';

import { artifacts, runCheckpoints, runEvents } from '@pertexo/database/schema';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

import { ARTIFACT_STATUS } from './contract.js';
import type { ArtifactStatus } from './contract.js';

export type ArtifactCapacityObservation = Readonly<{
  bytes: number;
  count: number;
  status: ArtifactStatus;
}>;

export type ExecutionStorageObservation = Readonly<{
  bytes: number;
  count: number;
  surface: 'checkpoint' | 'event';
}>;

function safeAggregateInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${field} exceeds the safe metric integer range`);
  }
  return parsed;
}

export async function readArtifactCapacity(
  transaction: WorkspaceTransaction,
): Promise<readonly ArtifactCapacityObservation[]> {
  const rows = await transaction.db
    .select({
      bytes: sql<string>`coalesce(sum(${artifacts.byteLength}), 0)::text`,
      count: sql<string>`count(*)::text`,
      status: artifacts.status,
    })
    .from(artifacts)
    .groupBy(artifacts.status);
  const byStatus = new Map(
    rows.map((row) => [
      row.status,
      Object.freeze({
        bytes: safeAggregateInteger(row.bytes, 'artifact bytes'),
        count: safeAggregateInteger(row.count, 'artifact count'),
      }),
    ]),
  );

  return Object.freeze(
    Object.values(ARTIFACT_STATUS)
      .sort()
      .map((status) =>
        Object.freeze({
          bytes: byStatus.get(status)?.bytes ?? 0,
          count: byStatus.get(status)?.count ?? 0,
          status,
        }),
      ),
  );
}

export async function readExecutionStorageCapacity(
  transaction: WorkspaceTransaction,
): Promise<readonly ExecutionStorageObservation[]> {
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
  const event = eventRows[0];
  const checkpoint = checkpointRows[0];
  return Object.freeze([
    Object.freeze({
      bytes: safeAggregateInteger(event?.bytes ?? '0', 'run event bytes'),
      count: safeAggregateInteger(event?.count ?? '0', 'run event count'),
      surface: 'event' as const,
    }),
    Object.freeze({
      bytes: safeAggregateInteger(
        checkpoint?.bytes ?? '0',
        'run checkpoint bytes',
      ),
      count: safeAggregateInteger(
        checkpoint?.count ?? '0',
        'run checkpoint count',
      ),
      surface: 'checkpoint' as const,
    }),
  ]);
}
