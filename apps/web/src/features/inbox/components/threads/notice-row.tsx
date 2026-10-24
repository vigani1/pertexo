import type {
  WorkspaceInboxThread,
  WorkspaceInboxAttentionThread,
} from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import type { ComponentProps, MouseEvent, ReactNode } from 'react';
import { ArrowRightIcon, CheckIcon } from 'lucide-react';
import { TaskDetailsLine } from '@/features/pending-tasks/public';
import { NoticeAction, NoticeFrame } from './frame';
import { noticeLinkClass } from './link-class';
import { InboxThreadRow } from './row';
const labels = {
  workflow_auto_paused: 'Workflow auto-paused',
  connection_attention: 'Connection needs attention',
  limit_reached: 'Workspace limit reached',
  limit_approaching: 'Workspace nearing a limit',
  approval_waiting: 'Approval waiting',
  publication_review_waiting: 'Publication review waiting',
  workflow_mention: 'Mentioned in a comment',
} as const;
const actionNames = {
  workflow_mention: 'Open discussion',
  publication_review_waiting: 'Review publication',
  approval_waiting: 'Review approval',
  connection_attention: 'Open connection',
  limit_reached: 'Review usage',
  limit_approaching: 'Review usage',
  workflow_auto_paused: 'Review workflow',
} as const;
/** Where a notice leads; the row's title and its action both go there. */
function AttentionLink({
  workspaceId,
  thread,
  onOpen,
  ...anchor
}: {
  workspaceId: string;
  thread: WorkspaceInboxAttentionThread;
  onOpen: () => void;
} & Omit<ComponentProps<'a'>, 'href' | 'target'>) {
  const params = { workspaceId };
  // A tooltip trigger renders through this link: its name, ref and handlers
  // land on the anchor.
  const look = {
    ...anchor,
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      anchor.onClick?.(event);
      onOpen();
    },
  };
  if (thread.noticeKind === 'workflow_mention')
    return (
      <Link
        to="/w/$workspaceId/workflows/$workflowId/comments"
        params={{ ...params, workflowId: thread.workflowId }}
        search={{ thread: thread.threadId, comment: thread.commentId }}
        {...look}
      ></Link>
    );
  if (thread.noticeKind === 'publication_review_waiting')
    return (
      <Link
        to="/w/$workspaceId/publish-reviews/$requestId"
        params={{ ...params, requestId: thread.subjectId }}
        {...look}
      ></Link>
    );
  if (thread.noticeKind === 'approval_waiting')
    return (
      <Link
        to="/w/$workspaceId/approvals/$taskId"
        params={{ ...params, taskId: thread.subjectId }}
        {...look}
      ></Link>
    );
  if (thread.noticeKind === 'connection_attention')
    return (
      <Link
        to="/w/$workspaceId/connections"
        params={params}
        search={{ connection: thread.subjectId }}
        {...look}
      ></Link>
    );
  if (
    thread.noticeKind === 'limit_reached' ||
    thread.noticeKind === 'limit_approaching'
  )
    return (
      <Link
        to="/w/$workspaceId/settings/usage"
        params={params}
        search={{ window: '24h' }}
        {...look}
      ></Link>
    );
  return (
    <Link
      to="/w/$workspaceId/workflows/$workflowId/settings"
      params={{ ...params, workflowId: thread.subjectId }}
      {...look}
    ></Link>
  );
}
const limitNames = {
  active: 'Active runs',
  queue: 'Queued runs',
  artifact_bytes: 'File storage',
  artifact_count: 'File count',
} as const;

/** The one line under a notice: what's waiting, or what's running short. */
function noticeSummary(thread: WorkspaceInboxAttentionThread): ReactNode {
  if (thread.noticeKind === 'approval_waiting')
    return <TaskDetailsLine details={thread.details} />;
  const limits = thread.limits.map((limit) => limitNames[limit]).join(' · ');
  if (thread.noticeKind === 'limit_approaching')
    return (
      <>
        {limits === '' ? null : <span>{limits} · </span>}
        <span>At least 80% of this capacity is in use.</span>
      </>
    );
  return limits === '' ? undefined : limits;
}

export function NoticeThreadRow(
  props: Readonly<{
    workspaceId: string;
    thread: WorkspaceInboxThread;
    nowMs: number;
    marking: boolean;
    onRead: () => void;
  }>,
) {
  const thread = props.thread;
  if (thread.noticeKind === 'workflow_failure')
    return <InboxThreadRow {...props} thread={thread} />;
  const waiting =
    thread.noticeKind === 'approval_waiting' ||
    thread.noticeKind === 'publication_review_waiting';
  const summary = noticeSummary(thread);
  return (
    <NoticeFrame
      unread={thread.unread}
      tone={waiting ? 'waiting' : 'attention'}
      word={labels[thread.noticeKind]}
      occurredAt={thread.latestOccurredAt}
      nowMs={props.nowMs}
      title={
        <AttentionLink
          workspaceId={props.workspaceId}
          thread={thread}
          onOpen={props.onRead}
          className={noticeLinkClass({ unread: thread.unread })}
        >
          {thread.name}
        </AttentionLink>
      }
      {...(summary === undefined ? {} : { summary })}
      actions={
        <>
          <NoticeAction
            label={actionNames[thread.noticeKind]}
            name={actionNames[thread.noticeKind]}
            render={
              <AttentionLink
                workspaceId={props.workspaceId}
                thread={thread}
                onOpen={props.onRead}
              />
            }
          >
            <ArrowRightIcon aria-hidden="true" />
          </NoticeAction>
          {thread.unread ? (
            <NoticeAction
              label="Mark read"
              name={`Mark ${thread.name} read`}
              render={
                <button
                  type="button"
                  disabled={props.marking}
                  onClick={props.onRead}
                />
              }
            >
              <CheckIcon aria-hidden="true" />
            </NoticeAction>
          ) : null}
        </>
      }
    />
  );
}
