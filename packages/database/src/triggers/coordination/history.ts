import type { PoolClient } from 'pg';
import type {
  CoordinatedEventHistory,
  CoordinatedEvent,
} from '@pertexo/contracts';

/** The only projection used by form history and webhook delivery enrichment. */
export const COORDINATED_EVENT_METADATA_SQL = `jsonb_build_object(
 'id',event.id,'nodeId',event.node_id,'source',event.source,'mode',event.mode,'outcome',event.initial_outcome,'status',event.status,'reason',event.reason,'runId',event.run_id,'versionNumber',event.version_number,
 'receivedAt',to_char(event.received_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'dueAt',case when event.due_at is null then null else to_char(event.due_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
 'finishedAt',case when event.finished_at is null then null else to_char(event.finished_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end)`;
export async function readCoordinatedEventHistory(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    workflowId: string;
    limit: number;
    before?: string;
    beforeId?: string;
  }>,
): Promise<CoordinatedEventHistory> {
  const result = await client.query<{ record: CoordinatedEvent }>(
    `select ${COORDINATED_EVENT_METADATA_SQL} record from app.trigger_coordinated_events event where event.workspace_id=$1 and event.workflow_id=$2 and event.source='form' and event.expires_at>clock_timestamp() and ($3::timestamptz is null or event.received_at<$3::timestamptz or (event.received_at=$3::timestamptz and event.id>$4::uuid)) order by event.received_at desc,event.id asc limit $5`,
    [
      input.workspaceId,
      input.workflowId,
      input.before ?? null,
      input.beforeId ?? null,
      input.limit + 1,
    ],
  );
  const items = result.rows.slice(0, input.limit).map((row) => row.record);
  const last = items.at(-1);
  return {
    items,
    next:
      result.rows.length > input.limit && last !== undefined
        ? { receivedAt: last.receivedAt, id: last.id }
        : null,
  };
}
