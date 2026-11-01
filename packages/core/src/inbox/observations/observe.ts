import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import {
  ATTENTION_PAGE_SIZE,
  readAttentionCandidates,
  type Candidate,
} from './candidates.queries.js';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import {
  workspaceInboxThreads as thread,
  workspaces,
  workspaceInboxRevisionSequence,
} from '@pertexo/database/schema';
import type { Pool, PoolClient } from 'pg';
import { generatePersistedId } from '@pertexo/database/platform';
import type { WorkspaceInboxChange } from '../folding/contract.js';
import { readAttentionFact, type AttentionFact } from './facts.queries.js';

const STATEMENT_TIMEOUT_MILLIS = 5_000;

/**
 * Keeps attention notices in step with their sources. Nobody is acting, so this
 * stays off `withWorkspaceAccess`. Keyset progress lives only in this scan; authoritative facts
 * make restart safe.
 */
export function createAttentionObserver(pool: Pool, maintenance: Pool) {
  let after: Candidate | undefined;
  return async (
    signal?: AbortSignal,
  ): Promise<readonly WorkspaceInboxChange[]> => {
    signal?.throwIfAborted();
    const candidates = await readAttentionCandidates(maintenance, after);
    const changes: WorkspaceInboxChange[] = [];
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      const changed = await withTenantScopedClient(
        pool,
        { workspaceId: candidate.workspace_id },
        async (client) => {
          const db = drizzle(client);
          const workspace = await db
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(
              and(
                eq(workspaces.id, candidate.workspace_id),
                eq(workspaces.status, 'active'),
              ),
            )
            .for('share')
            .catch(rethrowQueryFailure);
          if (workspace.length !== 1) return null;
          // The workspace fence fixes source/thread lock order for concurrent observers.
          const subjectKey =
            candidate.notice_kind === 'limit_approaching'
              ? `${candidate.subject_id}:${candidate.capacity_limit}`
              : candidate.subject_id;
          await db
            .execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${`notice:${candidate.workspace_id}:${candidate.notice_kind}:${subjectKey}`},0))`,
            )
            .catch(rethrowQueryFailure);
          const scope = {
            workspaceId: candidate.workspace_id,
            subjectId: candidate.subject_id,
          };
          const fact = await readAttentionFact(
            client,
            candidate.notice_kind === 'limit_approaching'
              ? {
                  ...scope,
                  noticeKind: candidate.notice_kind,
                  capacityLimit: candidate.capacity_limit,
                }
              : { ...scope, noticeKind: candidate.notice_kind },
          );
          const [row] = await db
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
          if (row === undefined && !fact.active) return null;
          const alreadyObserved =
            row?.active === fact.active &&
            (!fact.active || row.source_revision === fact.sourceRevision);
          if (alreadyObserved) return null;
          return writeAttentionThread(client, { candidate, row, fact });
        },
        {
          statementTimeoutMillis: STATEMENT_TIMEOUT_MILLIS,
          ...(signal === undefined ? {} : { signal }),
        },
      ).catch(rethrowQueryFailure);
      after = candidate;
      if (changed !== null)
        changes.push({
          workspaceId: candidate.workspace_id,
          revision: changed,
        });
    }
    if (candidates.length < ATTENTION_PAGE_SIZE) after = undefined;
    return changes;
  };
}

interface AttentionThread {
  id: string;
  active: boolean;
  source_revision: string | null;
}
async function writeAttentionThread(
  client: PoolClient,
  {
    candidate,
    row,
    fact,
  }: Readonly<{
    candidate: Candidate;
    row: AttentionThread | undefined;
    fact: AttentionFact;
  }>,
): Promise<string | null> {
  const threadId = row?.id ?? generatePersistedId();
  const countsNewOccurrence =
    fact.active &&
    (row === undefined ||
      !row.active ||
      candidate.notice_kind !== 'limit_reached');
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
