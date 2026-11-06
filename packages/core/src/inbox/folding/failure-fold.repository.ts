import { and, eq, inArray, sql, type SQLWrapper } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import {
  workspaceInboxEvents as events,
  workspaceInboxThreads as thread,
  workspaceInboxRevisionSequence,
} from '@pertexo/database/schema';
import { generatePersistedId } from '@pertexo/database/platform';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

export type ClaimedFailure = Readonly<{
  id: string;
  workspace_id: string;
  workflow_id: string;
  run_id: string;
  kind: string;
  occurred_at: string;
  workspace_status: string;
}>;
export type FailureEpisode = Readonly<{
  occurrenceCount: bigint;
  firstOccurredAt: string;
  latestOccurredAt: string;
  latestRunId: string;
  latestKind: string;
}>;
export type FailureScope = Readonly<{
  workspaceId: string;
  workflowId: string;
}>;

const nextRevision = sql`nextval(${[workspaceInboxRevisionSequence.schema, workspaceInboxRevisionSequence.seqName].join('.')}::regclass)`;
const utc = (value: SQLWrapper) =>
  sql<string>`to_char(${value} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export async function claimFailures(client: PoolClient, limit: number) {
  const db = drizzle(client);
  const clock = await db
    .execute<{ now: string }>(
      sql`select to_char(statement_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') now`,
    )
    .catch(rethrowQueryFailure);
  const now = clock.rows[0]?.now;
  if (now === undefined) throw new Error('Inbox fold clock unavailable');
  const claimed = await db
    .execute<ClaimedFailure>(
      sql`select * from app.claim_workspace_inbox_events(${limit})`,
    )
    .catch(rethrowQueryFailure);
  return { now, events: claimed.rows };
}

export async function insertFailureThread(
  client: PoolClient,
  scope: FailureScope,
  episode: FailureEpisode,
): Promise<string | undefined> {
  const [inserted] = await drizzle(client)
    .insert(thread)
    .values({
      ...scope,
      ...episode,
      id: generatePersistedId(),
      noticeKind: 'workflow_failure',
      subjectId: scope.workflowId,
      revision: nextRevision,
    })
    .onConflictDoNothing({
      target: [thread.workspaceId, thread.noticeKind, thread.subjectId],
    })
    .returning({ revision: sql<string>`${thread.revision}::text` })
    .catch(rethrowQueryFailure);
  return inserted?.revision;
}

export async function lockFailureThread(
  client: PoolClient,
  scope: FailureScope,
) {
  const [row] = await drizzle(client)
    .select({
      occurrenceCount: thread.occurrenceCount,
      firstOccurredAt: utc(thread.firstOccurredAt),
      latestOccurredAt: utc(thread.latestOccurredAt),
      latestRunId: thread.latestRunId,
      latestKind: thread.latestKind,
    })
    .from(thread)
    .where(subject(scope))
    .for('update')
    .catch(rethrowQueryFailure);
  if (row === undefined || row.latestRunId === null || row.latestKind === null)
    throw new Error('Inbox failure thread unavailable after insert conflict');
  return { ...row, latestRunId: row.latestRunId, latestKind: row.latestKind };
}

export async function replaceFailureEpisode(
  client: PoolClient,
  scope: FailureScope,
  episode: FailureEpisode,
): Promise<string> {
  const [row] = await drizzle(client)
    .update(thread)
    .set({
      ...episode,
      revision: nextRevision,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(subject(scope))
    .returning({ revision: sql<string>`${thread.revision}::text` })
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new Error('Locked Inbox failure thread unavailable');
  return row.revision;
}

export async function consumeFailures(
  client: PoolClient,
  workspaceId: string,
  ids: string[],
) {
  await drizzle(client)
    .delete(events)
    .where(and(eq(events.workspaceId, workspaceId), inArray(events.id, ids)))
    .catch(rethrowQueryFailure);
}

function subject(scope: FailureScope) {
  return and(
    eq(thread.workspaceId, scope.workspaceId),
    eq(thread.noticeKind, 'workflow_failure'),
    eq(thread.subjectId, scope.workflowId),
  );
}
