import type { PoolClient } from 'pg';
import { canonicalOutboxPayloadChecksum } from '../../outbox/events.js';
import { generatePersistedId } from '../../platform/persisted-id.js';

export async function wakeWorkflowRun(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  traceparent?: string,
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
     (id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum)
     values($1,$2,'advance-workflow-run','workflow-run',$3,$4::jsonb,$5)`,
    [
      id,
      workspaceId,
      runId,
      JSON.stringify(payload),
      canonicalOutboxPayloadChecksum(payload),
    ],
  );
  return id;
}
