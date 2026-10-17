import { CAPACITY_WARNING_CANDIDATES_SQL } from './capacity.js';
import type { WorkspaceCapacityLimit } from '@pertexo/contracts';
import type { Pool } from 'pg';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import type { WorkspaceInboxChange } from '../fold-store.js';
import { readAttentionFact, type AttentionSubject } from './facts.js';
type Candidate = Readonly<{
  workspace_id: string;
  subject_id: string;
}> &
  (
    | Readonly<{
        notice_kind: 'limit_approaching';
        capacity_limit: WorkspaceCapacityLimit;
      }>
    | Readonly<{
        notice_kind: Exclude<
          AttentionSubject['noticeKind'],
          'limit_approaching'
        >;
        capacity_limit: null;
      }>
  );
/** Keyset progress lives only in this scan; authoritative facts make restart safe. */
export function createAttentionObserver(pool: Pool, maintenance: Pool) {
  let after: Candidate | undefined;
  return async (
    signal?: AbortSignal,
  ): Promise<readonly WorkspaceInboxChange[]> => {
    signal?.throwIfAborted();
    const candidates = await maintenance.query<Candidate>(
      `with subjects as (
 select workspace_id,'workflow_auto_paused'::varchar notice_kind,id subject_id,null::varchar capacity_limit from app.workflows where trigger_pause_state='paused'
 union select workspace_id,'connection_attention',id,null::varchar from app.connections where status='reauthorization_required'
 union select workspace_id,'approval_waiting',id,null::varchar from app.pending_run_tasks where kind='approval' and status='pending'
 union select workspace_id,'limit_reached',workspace_id,null::varchar from app.workspace_artifact_capacity where charged_bytes>=byte_limit or charged_count>=artifact_count_limit
 union select counter.workspace_id,'limit_reached',counter.workspace_id,null::varchar from app.workspace_execution_admission_counters counter join app.workspace_execution_entitlements pointer on pointer.workspace_id=counter.workspace_id join app.workspace_execution_entitlement_versions entitlement on entitlement.workspace_id=pointer.workspace_id and entitlement.version=pointer.current_version where counter.queued_runs>=entitlement.queued_run_limit and entitlement.status='active' and entitlement.effective_at<=clock_timestamp() and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp())
 union select workspace_id,'limit_approaching',workspace_id,capacity_limit from (${CAPACITY_WARNING_CANDIDATES_SQL}) warning
 union select workspace_id,notice_kind,case when notice_kind='limit_approaching' then workspace_id else subject_id end,capacity_limit from app.workspace_inbox_threads where notice_kind<>'workflow_failure' and active)
 select subject.* from subjects subject join app.workspaces workspace on workspace.id=subject.workspace_id where workspace.status='active' and ($1::uuid is null or (subject.workspace_id,subject.notice_kind,subject.subject_id,coalesce(subject.capacity_limit,''))>($1::uuid,$2::varchar,$3::uuid,$4::varchar)) order by subject.workspace_id,subject.notice_kind,subject.subject_id,coalesce(subject.capacity_limit,'') limit 100`,
      [
        after?.workspace_id ?? null,
        after?.notice_kind ?? null,
        after?.subject_id ?? null,
        after?.capacity_limit ?? '',
      ],
    );
    const changes: WorkspaceInboxChange[] = [];
    for (const candidate of candidates.rows) {
      signal?.throwIfAborted();
      const changed = await withTenantScopedClient(
        pool,
        { workspaceId: candidate.workspace_id },
        async (client) => {
          const workspace = await client.query(
            "select id from app.workspaces where id=$1 and status='active' for share",
            [candidate.workspace_id],
          );
          if (workspace.rowCount !== 1) return null;
          // The workspace fence fixes source/thread lock order for concurrent observers.
          await client.query(
            'select pg_advisory_xact_lock(hashtextextended($1,0))',
            [
              `notice:${candidate.workspace_id}:${candidate.notice_kind}:${candidate.notice_kind === 'limit_approaching' ? `${candidate.subject_id}:${candidate.capacity_limit}` : candidate.subject_id}`,
            ],
          );
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
          const current = await client.query<{
            id: string;
            active: boolean;
            source_revision: string;
          }>(
            `select id,active,source_revision from app.workspace_inbox_threads where workspace_id=$1 and notice_kind=$2 and ${candidate.notice_kind === 'limit_approaching' ? 'capacity_limit=$3' : 'subject_id=$3::uuid'} for update`,
            [
              candidate.workspace_id,
              candidate.notice_kind,
              candidate.notice_kind === 'limit_approaching'
                ? candidate.capacity_limit
                : candidate.subject_id,
            ],
          );
          const row = current.rows[0];
          if (row === undefined && !fact.active) return null;
          if (
            row?.active === fact.active &&
            (!fact.active || row.source_revision === fact.sourceRevision)
          )
            return null;
          const threadId = row?.id ?? generatePersistedId();
          const result = await client.query<{ revision: string }>(
            `insert into app.workspace_inbox_threads as thread(workspace_id,id,notice_kind,subject_id,workflow_id,connection_id,task_id,active,source_revision,revision,occurrence_count,first_occurred_at,latest_occurred_at,capacity_limit)
 values($1,$2,$3,$4,$5,$6,$7,$8,$9,nextval('app.workspace_inbox_revision_seq'),1,clock_timestamp(),clock_timestamp(),$11)
 on conflict(workspace_id,notice_kind,subject_id) do update set active=excluded.active,source_revision=excluded.source_revision,revision=excluded.revision,occurrence_count=thread.occurrence_count+$10,latest_occurred_at=case when excluded.active then excluded.latest_occurred_at else thread.latest_occurred_at end,updated_at=clock_timestamp() returning revision::text`,
            [
              candidate.workspace_id,
              threadId,
              candidate.notice_kind,
              candidate.notice_kind === 'limit_approaching'
                ? threadId
                : candidate.subject_id,
              fact.workflowId,
              fact.connectionId,
              fact.taskId,
              fact.active,
              fact.sourceRevision,
              fact.active &&
              (row === undefined ||
                !row.active ||
                candidate.notice_kind !== 'limit_reached')
                ? 1
                : 0,
              candidate.capacity_limit,
            ],
          );
          return result.rows[0]?.revision ?? null;
        },
        {
          statementTimeoutMillis: 5000,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      after = candidate;
      if (changed !== null)
        changes.push({
          workspaceId: candidate.workspace_id,
          revision: changed,
        });
    }
    if (candidates.rows.length < 100) after = undefined;
    return changes;
  };
}
