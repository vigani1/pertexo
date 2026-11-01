import {
  sealNoticeUnsubscribe,
  type ApplicationSecretEnvelope,
} from '@pertexo/integrations/server';
import type { NoticeMailItem, NoticeMailToSeal } from '@pertexo/core/inbox';
const labels = {
  workflow_failure: 'Workflow failed',
  workflow_auto_paused: 'Workflow auto-paused',
  connection_attention: 'Connection needs attention',
  limit_reached: 'Workspace limit reached',
  limit_approaching: 'Workspace nearing a limit',
  approval_waiting: 'Approval waiting',
  publication_review_waiting: 'Publication review waiting',
  workflow_mention: 'Mentioned in a comment',
} as const;
/** Only the database's safe projection enters personal mail. */
export function sealNoticeMail(
  envelope: ApplicationSecretEnvelope,
  fromEmail: string,
  publicWebOrigin: string,
  input: NoticeMailToSeal,
) {
  const inbox = new URL(`/w/${input.workspaceId}/inbox`, publicWebOrigin).href;
  const token = sealNoticeUnsubscribe(envelope, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    revision: input.revision,
    memberRevision: input.memberRevision,
    expiresAt: new Date(
      input.expiresAt.getTime() + 89 * 86400000,
    ).toISOString(),
  });
  const unsubscribe = new URL('/notifications/unsubscribe', publicWebOrigin);
  unsubscribe.hash = token;
  const oneClick = new URL(
    '/v1/notifications/unsubscribe/one-click',
    publicWebOrigin,
  );
  oneClick.searchParams.set('token', token);
  const message = {
    fromEmail,
    toEmail: input.toEmail,
    subject: noticeSubject(input),
    unsubscribeUrl: oneClick.href,
    text: '',
  };
  let serialized = '';
  for (let count = Math.min(input.items.length, 25); count >= 0; count--) {
    message.text = [
      ...input.items
        .slice(0, count)
        .map((item) => noticeLine(item, input.workspaceId, publicWebOrigin)),
      ...(input.items.length > count
        ? [String(input.items.length - count) + ' more notices in your Inbox.']
        : []),
      '',
      'Open your Inbox: ' + inbox,
      '',
      'Turn off personal email notifications: ' + unsubscribe.href,
    ].join('\n');
    serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized, 'utf8') <= 12_288) break;
    if (count === 0)
      throw new RangeError('Notification mail exceeds its bounded envelope');
  }
  return envelope.seal(
    serialized,
    `pertexo/authentication-mail/workspace_notice/${input.id}/${input.expiresAt.toISOString()}`,
  );
}

function noticeName(name: string): string {
  return Array.from(name.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' '))
    .slice(0, 64)
    .join('')
    .trim();
}
function noticeSubject(input: NoticeMailToSeal): string {
  const workspace = noticeName(input.workspaceName);
  const subject = input.items.find(
    (item) => item.noticeKind !== 'limit_reached',
  );
  if (input.items.length === 1)
    return subject === undefined
      ? `${labels.limit_reached} — ${workspace}`
      : `${labels[subject.noticeKind]}: ${noticeName(subject.name)} — ${workspace}`;
  return `${String(input.items.length)} notices${subject === undefined ? '' : `: ${noticeName(subject.name)}`} — ${workspace}`;
}

function noticeLine(
  item: NoticeMailItem,
  workspaceId: string,
  origin: string,
): string {
  const label = labels[item.noticeKind] + ': ' + noticeName(item.name);
  if (item.noticeKind === 'workflow_failure')
    return label + ' (' + String(item.count) + ')';
  if (item.noticeKind !== 'workflow_mention') return label;
  const discussion = new URL(
    '/w/' + workspaceId + '/workflows/' + item.workflowId + '/comments',
    origin,
  );
  discussion.searchParams.set('thread', item.discussion.threadId);
  discussion.searchParams.set('comment', item.discussion.commentId);
  return label + '\n' + discussion.href;
}
