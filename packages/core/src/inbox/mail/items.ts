import { CAPACITY_LIMIT_LABELS } from '../observations/capacity-labels.js';
import { FAILURE_ALERT_CHANNEL_NAMES } from '../threads/alert-channels.js';
import type { NoticeMailItem } from './contract.js';
import type { MailSubjectRow } from './subjects.queries.js';

export function mailItem(row: MailSubjectRow): NoticeMailItem {
  if (row.notice_kind === 'workflow_mention')
    return {
      id: row.id,
      revision: row.revision,
      noticeKind: row.notice_kind,
      name: row.name,
      count: Number(row.occurrence_count),
      subjectId: row.subject_id,
      workflowId: row.workflow_id,
      discussion: {
        threadId: row.comment_thread_id,
        commentId: row.comment_id,
      },
    };
  return {
    id: row.id,
    revision: row.revision,
    noticeKind: row.notice_kind,
    name: itemName(row),
    count: Number(row.occurrence_count),
    subjectId: row.subject_id,
    workflowId: row.workflow_id,
  };
}

function itemName(row: MailSubjectRow): string {
  if (row.notice_kind === 'limit_approaching')
    return CAPACITY_LIMIT_LABELS[row.capacity_limit];
  if (row.notice_kind === 'failure_alert_attention')
    return FAILURE_ALERT_CHANNEL_NAMES[row.destination_kind];
  return row.name;
}

/** Only what happened after they chose this schedule and joined goes in a mail. */
export function mailCutoff(settingsChangedAt: Date, memberSince: Date): Date {
  return new Date(Math.max(settingsChangedAt.getTime(), memberSince.getTime()));
}
