import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workspaceInboxThreads as thread,
  workspaces,
  workspaceInboxRevisionSequence,
} from '@pertexo/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';

import type { Candidate } from './candidates.repository.js';
import type { AttentionFact } from './facts.repository.js';

export interface AttentionThread {
  id: string;
  active: boolean;
  source_revision: string | null;
}

/** Whether the workspace is active and not held by another observer. */
export async function claimActiveWorkspace(
  client: PoolClient,
  workspaceId: string,
): Promise<boolean> {
  const workspace = await drizzle(client)
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.status, 'active')))
    .for('no key update', { skipLocked: true })
    .catch(rethrowQueryFailure);
  return workspace.length === 1;
}

export async function lockAttentionThread(
  client: PoolClient,
  candidate: Candidate,
): Promise<AttentionThread | undefined> {
  const [row] = await drizzle(client)
    .select({
      id: thread.id,
      active: thread.active,
      source_revision: thread.sourceRevision,
    })
    .from(thread)
    .where(
      and(
        eq(thread.workspaceId, candidate.workspace_id),
        eq(thread.noticeKind, candidate.notice_kind),
        candidate.notice_kind === 'limit_approaching'
          ? eq(thread.capacityLimit, candidate.capacity_limit)
          : eq(thread.subjectId, candidate.subject_id),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  return row;
}

/** The thread's new revision, or null when nothing was written. */
export async function saveAttentionThread(
  client: PoolClient,
  {
    candidate,
    threadId,
    fact,
    countsNewOccurrence,
  }: Readonly<{
    candidate: Candidate;
    threadId: string;
    fact: AttentionFact;
    countsNewOccurrence: boolean;
  }>,
): Promise<string | null> {
  const excluded = alias(thread, 'excluded');
  const occurredAt = sql`coalesce(${fact.occurredAt}::timestamptz,clock_timestamp())`;
  const [result] = await drizzle(client)
    .insert(thread)
    .values({
      workspaceId: candidate.workspace_id,
      id: threadId,
      noticeKind: candidate.notice_kind,
      subjectId:
        candidate.notice_kind === 'limit_approaching'
          ? threadId
          : candidate.subject_id,
      workflowId: fact.workflowId,
      connectionId: fact.connectionId,
      taskId: fact.taskId,
      active: fact.active,
      sourceRevision: fact.sourceRevision,
      revision: sql`nextval(${[workspaceInboxRevisionSequence.schema, workspaceInboxRevisionSequence.seqName].join('.')}::regclass)`,
      occurrenceCount: 1n,
      firstOccurredAt: occurredAt,
      latestOccurredAt: occurredAt,
      capacityLimit: candidate.capacity_limit,
      publicationRequestId: fact.publicationRequestId,
      commentMentionId: fact.commentMentionId,
    })
    .onConflictDoUpdate({
      target: [thread.workspaceId, thread.noticeKind, thread.subjectId],
      set: {
        active: sql`${excluded.active}`,
        sourceRevision: sql`${excluded.sourceRevision}`,
        revision: sql`${excluded.revision}`,
        occurrenceCount: sql`${thread.occurrenceCount}+${countsNewOccurrence ? 1 : 0}`,
        latestOccurredAt: sql`case when ${excluded.active} then ${excluded.latestOccurredAt} else ${thread.latestOccurredAt} end`,
        updatedAt: sql`clock_timestamp()`,
      },
    })
    .returning({ revision: sql<string>`${thread.revision}::text` })
    .catch(rethrowQueryFailure);
  return result?.revision ?? null;
}
