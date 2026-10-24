import { z } from 'zod';
import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../../outbox/events.repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';

import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';

export function withoutNulls(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, entry]) => entry !== null && entry !== undefined,
    ),
  );
}

export async function enqueue(
  transaction: WorkspaceTransaction,
  job: Readonly<{
    jobName: string;
    aggregateType: string;
    aggregateId: string;
    fields: Readonly<Record<string, string>>;
  }>,
): Promise<string> {
  const id = generatePersistedId();
  const payload = {
    ...job.fields,
    outboxEventId: id,
    workspaceId: transaction.workspaceId,
  };
  await insertOutboxEvent(transaction, {
    id,
    jobName: job.jobName,
    aggregateType: job.aggregateType,
    aggregateId: job.aggregateId,
    payload,
    payloadChecksum: canonicalOutboxPayloadChecksum(payload),
  });
  return id;
}

export const enqueueAdvance = (
  transaction: WorkspaceTransaction,
  runId: string,
): Promise<string> =>
  enqueue(transaction, {
    jobName: 'advance-workflow-run',
    aggregateType: 'workflow-run',
    aggregateId: runId,
    fields: { runId },
  });

export const optionalDate = z
  .union([z.date(), z.string()])
  .nullable()
  .transform((value) =>
    value === null ? null : new Date(value).toISOString(),
  );
