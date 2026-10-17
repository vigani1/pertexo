import {
  sealNoticeUnsubscribe,
  type ApplicationSecretEnvelope,
} from '@pertexo/integrations/server';
import type { NoticeMailToSeal } from '@pertexo/database/notifications';
const labels = {
  workflow_failure: 'Workflow failed',
  workflow_auto_paused: 'Workflow auto-paused',
  connection_attention: 'Connection needs attention',
  limit_reached: 'Workspace limit reached',
  limit_approaching: 'Workspace nearing a limit',
  approval_waiting: 'Approval waiting',
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
  const lines = input.items
    .slice(0, 25)
    .map(
      (item) =>
        `${labels[item.noticeKind]}: ${noticeName(item.name)}${item.noticeKind === 'workflow_failure' ? ` (${String(item.count)})` : ''}`,
    );
  const text = [
    ...lines,
    ...(input.items.length > 25
      ? [`${String(input.items.length - 25)} more notices in your Inbox.`]
      : []),
    '',
    `Open your Inbox: ${inbox}`,
    '',
    `Turn off personal email notifications: ${unsubscribe.href}`,
  ].join('\n');
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
    text,
  };
  const serialized = JSON.stringify(message);
  if (Buffer.byteLength(serialized, 'utf8') > 12_288)
    throw new RangeError('Notification mail exceeds its bounded envelope');
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
