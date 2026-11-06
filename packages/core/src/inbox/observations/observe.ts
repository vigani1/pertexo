import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import {
  ATTENTION_PAGE_SIZE,
  readAttentionCandidates,
  type Candidate,
} from './candidates.repository.js';
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
import type { WorkspaceInboxChange } from '../folding/workspace-inbox-change.types.js';
import { readAttentionFact, type AttentionFact } from './facts.repository.js';

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
    const byWorkspace = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
      const group = byWorkspace.get(candidate.workspace_id) ?? [];
      group.push(candidate);
      byWorkspace.set(candidate.workspace_id, group);
    }
    for (const [workspaceId, subjects] of byWorkspace) {
      signal?.throwIfAborted();
      const committed = await withTenantScopedClient(
        pool,
        { workspaceId },
        async (client) => {
          const db = drizzle(client);
          // Claim the workspace's page together, preserving workspace/source/thread order.
          // A locked workspace returns on the next keyset pass.
          const workspace = await db
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(
              and(
                eq(workspaces.id, workspaceId),
                eq(workspaces.status, 'active'),
              ),
            )
            .for('no key update', { skipLocked: true })
            .catch(rethrowQueryFailure);
          if (workspace.length !== 1) return [];
          const observed: WorkspaceInboxChange[] = [];
          for (const candidate of subjects) {
            signal?.throwIfAborted();
            const revision = await observeSubject(client, candidate);
            if (revision !== null) observed.push({ workspaceId, revision });
          }
          return observed;
        },
        {
          statementTimeoutMillis: STATEMENT_TIMEOUT_MILLIS,
          ...(signal === undefined ? {} : { signal }),
        },
      ).catch(rethrowQueryFailure);
      changes.push(...committed);
    }
    after = candidates.at(-1);
    if (candidates.length < ATTENTION_PAGE_SIZE) after = undefined;
    return changes;
  };
}

async function observeSubject(
  client: PoolClient,
  candidate: Candidate,
): Promise<string | null> {
  const db = drizzle(client);
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
