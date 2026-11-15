import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import {
  ATTENTION_PAGE_SIZE,
  readAttentionCandidates,
  type Candidate,
} from './candidates.repository.js';
import type { Pool, PoolClient } from 'pg';
import { generatePersistedId } from '@pertexo/database/platform';
import type { WorkspaceInboxChange } from '../folding/workspace-inbox-change.types.js';
import { readAttentionFact, type AttentionFact } from './facts.repository.js';
import {
  claimActiveWorkspace,
  lockAttentionThread,
  saveAttentionThread,
  type AttentionThread,
} from './attention-threads.repository.js';

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
          // Claim the workspace's page together, preserving workspace/source/thread order.
          // A locked workspace returns on the next keyset pass.
          const claimed = await claimActiveWorkspace(client, workspaceId);
          if (!claimed) return [];
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
  const row = await lockAttentionThread(client, candidate);
  if (row === undefined && !fact.active) return null;
  const alreadyObserved =
    row?.active === fact.active &&
    (!fact.active || row.source_revision === fact.sourceRevision);
  if (alreadyObserved) return null;
  return writeAttentionThread(client, { candidate, row, fact });
}

/** A new occurrence counts unless a reached limit is merely still reached. */
function writeAttentionThread(
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
  const countsNewOccurrence =
    fact.active &&
    (row === undefined ||
      !row.active ||
      candidate.notice_kind !== 'limit_reached');
  return saveAttentionThread(client, {
    candidate,
    threadId: row?.id ?? generatePersistedId(),
    fact,
    countsNewOccurrence,
  });
}
