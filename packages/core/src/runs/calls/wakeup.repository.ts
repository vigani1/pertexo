import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { outboxEvents } from '@pertexo/database/schema';
import {
  rethrowQueryFailure,
  canonicalOutboxPayloadChecksum,
} from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import { generatePersistedId } from '@pertexo/database/platform';

async function enqueueWorkflowRun(
  client: PoolClient,
  workspaceId: string,
  {
    runId,
    traceparent,
    delaySeconds,
  }: Readonly<{
    runId: string;
    traceparent: string | undefined;
    delaySeconds: number;
  }>,
): Promise<string> {
  const id = generatePersistedId();
  const payload = {
    workspaceId,
    runId,
    outboxEventId: id,
    ...(traceparent === undefined ? {} : { traceparent }),
  };
  await drizzle(client)
    .insert(outboxEvents)
    .values({
      id,
      workspaceId,
      jobName: 'advance-workflow-run',
      aggregateType: 'workflow-run',
      aggregateId: runId,
      payload: sql`${JSON.stringify(payload)}::jsonb`,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
      availableAt: sql`clock_timestamp()+make_interval(secs=>${delaySeconds})`,
    })
    .catch(rethrowQueryFailure);
  return id;
}

export function wakeWorkflowRun(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  traceparent?: string,
): Promise<string> {
  return enqueueWorkflowRun(client, workspaceId, {
    runId,
    traceparent,
    delaySeconds: 0,
  });
}
export function deferWorkflowRun(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  traceparent?: string,
): Promise<string> {
  return enqueueWorkflowRun(client, workspaceId, {
    runId,
    traceparent,
    delaySeconds: 5,
  });
}
