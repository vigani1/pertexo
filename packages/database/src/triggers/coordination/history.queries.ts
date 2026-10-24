import { and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { triggerCoordinatedEvents } from '../../schema/event-coordination/records.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import type {
  CoordinatedEventHistory,
  CoordinatedEvent,
} from '@pertexo/contracts';

const event = alias(triggerCoordinatedEvents, 'event');
/** The only projection used by form history and webhook delivery enrichment. */
export const COORDINATED_EVENT_METADATA = sql<CoordinatedEvent>`jsonb_build_object(
 'id',${event.id},'nodeId',${event.nodeId},'source',${event.source},'mode',${event.mode},'outcome',${event.initialOutcome},
 'status',${event.status},'reason',${event.reason},'runId',${event.runId},'versionNumber',${event.versionNumber},
 'receivedAt',to_char(${event.receivedAt} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'dueAt',to_char(${event.dueAt} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'finishedAt',to_char(${event.finishedAt} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))`;
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
  const result = await drizzle(client)
    .select({ record: COORDINATED_EVENT_METADATA })
    .from(event)
    .where(
      and(
        eq(event.workspaceId, input.workspaceId),
        eq(event.workflowId, input.workflowId),
        eq(event.source, 'form'),
        sql`${event.expiresAt}>clock_timestamp()`,
        sql`(${input.before ?? null}::timestamptz is null or ${event.receivedAt}<${input.before ?? null}::timestamptz or
        (${event.receivedAt}=${input.before ?? null}::timestamptz and ${event.id}>${input.beforeId ?? null}::uuid))`,
      ),
    )
    .orderBy(desc(event.receivedAt), event.id)
    .limit(input.limit + 1)
    .catch(rethrowQueryFailure);
  const items = result.slice(0, input.limit).map((row) => row.record);
  const last = items.at(-1);
  return {
    items,
    next:
      result.length > input.limit && last !== undefined
        ? { receivedAt: last.receivedAt, id: last.id }
        : null,
  };
}
