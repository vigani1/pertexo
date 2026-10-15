import type { PoolClient } from 'pg';
import type { WorkspaceNoticeKind } from '@pertexo/contracts';
import { noticeVisibilitySql } from '../eligibility.js';
import { readAttentionFact } from '../observations/facts.js';
import type { NoticeMailItem } from './contract.js';
export type MailSubjectRow = Readonly<{
  id: string;
  notice_kind: WorkspaceNoticeKind;
  subject_id: string;
  workflow_id: string | null;
  revision: string;
  name: string;
  occurrence_count: string;
}>;
/** Bounded current subjects; no run values, errors or task instructions are selected. */
export async function readMailSubjects(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  cut: Date,
  onlyIds?: readonly string[],
): Promise<readonly MailSubjectRow[]> {
  const found = await client.query<MailSubjectRow>(
    `select thread.id,thread.notice_kind,thread.subject_id,thread.workflow_id,thread.revision::text,thread.occurrence_count::text,coalesce(workflow.name,connection.name,workspace.name) name
 from app.workspace_inbox_threads thread join app.workspaces workspace on workspace.id=thread.workspace_id
 left join app.workflows workflow on workflow.workspace_id=thread.workspace_id and workflow.id=thread.workflow_id
 left join app.connections connection on connection.workspace_id=thread.workspace_id and connection.id=thread.connection_id
 left join app.notice_subscriptions sub on sub.workspace_id=thread.workspace_id and sub.user_id=$2 and ((sub.subject_kind='workflow' and sub.subject_id=thread.workflow_id) or (sub.subject_kind='connection' and sub.subject_id=thread.connection_id))
 where thread.workspace_id=$1 and ${noticeVisibilitySql('$2')} and thread.latest_occurred_at>$3 and thread.latest_occurred_at>clock_timestamp()-interval '720 hours'
 and (sub.changed_at is null or thread.latest_occurred_at>sub.changed_at)
 and ($4::uuid[] is null or thread.id=any($4))
 and (thread.notice_kind='workflow_failure' or (thread.notice_kind='workflow_auto_paused' and workflow.trigger_pause_state='paused') or (thread.notice_kind='connection_attention' and connection.status='reauthorization_required') or thread.notice_kind='limit_reached' or thread.notice_kind='approval_waiting')
 and ($4::uuid[] is not null or not exists(select 1 from app.notice_mail_items item join app.notice_mail_batches batch on batch.workspace_id=item.workspace_id and batch.id=item.batch_id join app.authentication_mail_deliveries delivery on delivery.id=batch.id where item.workspace_id=thread.workspace_id and item.thread_id=thread.id and item.revision>=thread.revision and batch.user_id=$2 and batch.released_at is null))
 order by thread.latest_occurred_at,thread.id limit 100`,
    [workspaceId, actorId, cut, onlyIds ?? null],
  );
  const current: MailSubjectRow[] = [];
  // Audience and task eligibility filter before LIMIT; capacity facts are rechecked before use.
  for (const row of found.rows) {
    if (row.notice_kind === 'limit_reached') {
      const fact = await readAttentionFact(client, {
        workspaceId,
        noticeKind: row.notice_kind,
        subjectId: row.subject_id,
      });
      if (!fact.active) continue;
    }
    current.push(row);
  }
  return current;
}
export function mailItem(row: MailSubjectRow): NoticeMailItem {
  return {
    id: row.id,
    revision: row.revision,
    noticeKind: row.notice_kind,
    name: row.name,
    count: Number(row.occurrence_count),
    subjectId: row.subject_id,
    workflowId: row.workflow_id,
  };
}
