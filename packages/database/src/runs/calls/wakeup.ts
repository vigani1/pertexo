import type { PoolClient } from 'pg';
import { canonicalOutboxPayloadChecksum } from '../../outbox/events.repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';

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
  await client.query(
    `insert into app.outbox_events
     (id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum,available_at)
     values($1,$2,'advance-workflow-run','workflow-run',$3,$4::jsonb,$5,clock_timestamp()+make_interval(secs=>$6))`,
    [
      id,
      workspaceId,
      runId,
      JSON.stringify(payload),
      canonicalOutboxPayloadChecksum(payload),
      delaySeconds,
    ],
  );
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
