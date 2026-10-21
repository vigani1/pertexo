import { readCommentMentionSource } from './mentions.js';
import {
  REVIEW_SOURCE_SQL,
  REVIEW_STATE_SQL,
} from '../../authoring/reviews/eligibility.js';
import type { PoolClient } from 'pg';
import { readCapacityWarning } from './capacity.js';
import type {
  WorkspaceCapacityLimit,
  WorkspaceNoticeKind,
} from '@pertexo/contracts';
export type AttentionSubject = Readonly<{
  workspaceId: string;
  subjectId: string;
}> &
  (
    | Readonly<{
        noticeKind: 'limit_approaching';
        capacityLimit: WorkspaceCapacityLimit;
      }>
    | Readonly<{
        noticeKind: Exclude<
          WorkspaceNoticeKind,
          'workflow_failure' | 'limit_approaching'
        >;
      }>
  );
export type AttentionFact = Readonly<{
  active: boolean;
  sourceRevision: string;
  workflowId: string | null;
  connectionId: string | null;
  taskId: string | null;
  publicationRequestId: string | null;
  commentMentionId: string | null;
  occurredAt: Date | null;
}>;
/** Current source facts, read under the observation's workspace/source fence. */
export async function readAttentionFact(
  client: PoolClient,
  subject: AttentionSubject,
): Promise<AttentionFact> {
  const base = {
    active: false,
    sourceRevision: 'resolved',
    workflowId: null,
    connectionId: null,
    taskId: null,
    publicationRequestId: null,
    commentMentionId: null,
    occurredAt: null,
  };
  const values = [subject.workspaceId, subject.subjectId];
  switch (subject.noticeKind) {
    case 'workflow_mention': {
      const source = await readCommentMentionSource(client, subject);
      return {
        ...base,
        workflowId: source?.workflowId ?? null,
        commentMentionId: subject.subjectId,
        active: source?.active ?? false,
        sourceRevision: subject.subjectId,
        occurredAt: source?.occurredAt ?? null,
      };
    }
    case 'workflow_auto_paused': {
      const found = await client.query<{
        trigger_pause_state: string;
        trigger_pause_revision: string;
      }>(
        'select trigger_pause_state,trigger_pause_revision::text from app.workflows where workspace_id=$1 and id=$2 for share',
        values,
      );
      const row = found.rows[0];
      return {
        ...base,
        workflowId: subject.subjectId,
        active: row?.trigger_pause_state === 'paused',
        sourceRevision: row?.trigger_pause_revision ?? 'removed',
      };
    }
    case 'connection_attention': {
      const found = await client.query<{
        status: string;
        health_revision: string;
      }>(
        'select status,health_revision::text from app.connections where workspace_id=$1 and id=$2 for share',
        values,
      );
      const row = found.rows[0];
      return {
        ...base,
        connectionId: subject.subjectId,
        active: row?.status === 'reauthorization_required',
        sourceRevision: row?.health_revision ?? 'removed',
      };
    }
    case 'publication_review_waiting': {
      const row = (
        await client.query<{ workflow_id: string; active: boolean }>(
          `select review.workflow_id,((${REVIEW_STATE_SQL})='pending') active ${REVIEW_SOURCE_SQL} where review.workspace_id=$1 and review.id=$2`,
          values,
        )
      ).rows[0];
      return {
        ...base,
        workflowId: row?.workflow_id ?? null,
        publicationRequestId: subject.subjectId,
        active: row?.active === true,
        sourceRevision: subject.subjectId,
      };
    }
    case 'approval_waiting': {
      // Decisions and the coordinator lock the run before its task.
      await client.query(
        `select id from app.workflow_runs where workspace_id=$1 and id=(
          select run_id from app.pending_run_tasks where workspace_id=$1 and id=$2
        ) for share`,
        values,
      );
      const found = await client.query<{
        workflow_id: string;
        pending: boolean;
      }>(
        `select run.workflow_id,(task.kind='approval' and task.status='pending' and task.expires_at>clock_timestamp() and run.status in ('queued','running','waiting') and run.cancel_requested_at is null and (run.deadline_at is null or run.deadline_at>clock_timestamp())) pending from app.pending_run_tasks task join app.workflow_runs run on run.workspace_id=task.workspace_id and run.id=task.run_id where task.workspace_id=$1 and task.id=$2 for share of task`,
        values,
      );
      const row = found.rows[0];
      return {
        ...base,
        workflowId: row?.workflow_id ?? null,
        taskId: subject.subjectId,
        active: row?.pending === true,
        sourceRevision: subject.subjectId,
      };
    }
    case 'limit_approaching':
      return {
        ...base,
        active: await readCapacityWarning(
          client,
          subject.workspaceId,
          subject.capacityLimit,
        ),
        sourceRevision: subject.capacityLimit,
      };
    case 'limit_reached': {
      const found = await client.query<{
        queue: boolean;
        artifact_bytes: boolean;
        artifact_count: boolean;
      }>(
        `select
 coalesce(entitlement.status='active' and entitlement.effective_at<=clock_timestamp() and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp()) and counts.queued_runs>=entitlement.queued_run_limit,false) queue,
 coalesce(capacity.charged_bytes>=capacity.byte_limit,false) artifact_bytes,coalesce(capacity.charged_count>=capacity.artifact_count_limit,false) artifact_count
 from app.workspaces workspace cross join app.workflow_run_slot_counts(workspace.id) counts
 left join app.workspace_execution_entitlements pointer on pointer.workspace_id=workspace.id
 left join app.workspace_execution_entitlement_versions entitlement on entitlement.workspace_id=pointer.workspace_id and entitlement.version=pointer.current_version
 left join app.workspace_artifact_capacity capacity on capacity.workspace_id=workspace.id where workspace.id=$1 and workspace.status='active'`,
        [subject.workspaceId],
      );
      const row = found.rows[0];
      const limits = (
        ['queue', 'artifact_bytes', 'artifact_count'] as const
      ).filter((key) => row?.[key] === true);
      return {
        ...base,
        active: limits.length > 0,
        sourceRevision: limits.join(','),
      };
    }
  }
}
