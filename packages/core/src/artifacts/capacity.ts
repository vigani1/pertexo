import type { WorkspaceTransaction } from '@pertexo/database/primitives';

import { ARTIFACT_STATUS } from './artifact.js';
import type { ArtifactStatus } from './artifact.js';
import {
  readArtifactCapacityAggregates,
  readExecutionStorageAggregates,
} from './capacity.repository.js';

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

export async function readArtifactCapacity(
  transaction: WorkspaceTransaction,
): Promise<readonly ArtifactCapacityObservation[]> {
  const rows = await readArtifactCapacityAggregates(transaction);
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
  const { event, checkpoint } =
    await readExecutionStorageAggregates(transaction);
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

function safeAggregateInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${field} exceeds the safe metric integer range`);
  }
  return parsed;
}
