import type { PoolClient } from 'pg';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { canonicalOutboxPayloadChecksum } from '../../outbox/events.repository.js';
import {
  ErrorWorkflowDeliveryMismatchError,
  type ErrorWorkflowDeliveryInput,
} from './contract.js';

const waitSeconds = 15 * 60;

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
    values($1,$2,'start-error-workflow','workflow-run',$3,$4::jsonb,$5,$6::timestamptz)`,
    [
      outboxEventId,
      input.workspaceId,
      input.sourceRunId,
      JSON.stringify(payload),
      canonicalOutboxPayloadChecksum(payload),
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

/** The run transition holds the execution counter until these wakeups commit. */
export async function wakeErrorWorkflowsForCapacity(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  await client.query(
    `with ready as (
    select event.id from app.outbox_events event
    join app.run_error_workflow_intents intent on intent.workspace_id=event.workspace_id and intent.outbox_event_id=event.id
    where intent.workspace_id=$1 and intent.status='pending'
      and intent.queue_wait_expires_at > clock_timestamp()
      and event.available_at > clock_timestamp() and event.published_at is null and event.failed_at is null
      and (event.lease_expires_at is null or event.lease_expires_at <= clock_timestamp())
    order by intent.created_at,intent.source_run_id limit 100
  ) update app.outbox_events event set available_at=clock_timestamp(),updated_at=clock_timestamp()
    from ready where event.workspace_id=$1 and event.id=ready.id`,
    [workspaceId],
  );
}
