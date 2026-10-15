import type { PoolClient } from 'pg';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { canonicalOutboxPayloadChecksum } from '../../outbox/events.js';
import {
  ErrorWorkflowDeliveryMismatchError,
  type ErrorWorkflowDeliveryInput,
} from './contract.js';

const waitSeconds = 15 * 60;
const retrySeconds = 30;

/** The locked intent and claimed receipt make replacement delivery atomic. */
export async function deferErrorWorkflowForQueue(
  client: PoolClient,
  input: ErrorWorkflowDeliveryInput,
): Promise<boolean> {
  const saved = await client.query<{ expires_at: Date; now: Date }>(
    `update app.run_error_workflow_intents set queue_wait_expires_at=coalesce(queue_wait_expires_at,clock_timestamp()+make_interval(secs=>$3))
    where workspace_id=$1 and source_run_id=$2 and status='pending'
    returning queue_wait_expires_at expires_at,clock_timestamp() now`,
    [input.workspaceId, input.sourceRunId, waitSeconds],
  );
  const observation = saved.rows[0];
  if (observation === undefined) throw new ErrorWorkflowDeliveryMismatchError();
  if (observation.expires_at <= observation.now) return false;
  const outboxEventId = generatePersistedId();
  const payload = {
    workspaceId: input.workspaceId,
    sourceRunId: input.sourceRunId,
    outboxEventId,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  };
  await client.query(
    `insert into app.outbox_events(id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum,available_at)
    values($1,$2,'start-error-workflow','workflow-run',$3,$4::jsonb,$5,least(clock_timestamp()+make_interval(secs=>$6),$7::timestamptz))`,
    [
      outboxEventId,
      input.workspaceId,
      input.sourceRunId,
      JSON.stringify(payload),
      canonicalOutboxPayloadChecksum(payload),
      retrySeconds,
      observation.expires_at,
    ],
  );
  const updated = await client.query(
    'update app.run_error_workflow_intents set outbox_event_id=$3 where workspace_id=$1 and source_run_id=$2 and outbox_event_id=$4',
    [input.workspaceId, input.sourceRunId, outboxEventId, input.outboxEventId],
  );
  if (updated.rowCount !== 1) throw new ErrorWorkflowDeliveryMismatchError();
  return true;
}
