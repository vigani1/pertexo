import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '@pertexo/database/primitives';
import { generatePersistedId } from '@pertexo/database/platform';

import type { WorkspaceTransaction } from '@pertexo/database/primitives';

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
