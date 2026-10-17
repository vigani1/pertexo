import type {
  WorkspaceInboxThread,
  WorkspaceInboxAttentionThread,
} from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { StatusGlyph } from '@/components/ui/status';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format/time';
import { InboxThreadRow } from './row';
import { TaskDetails } from '@/features/pending-tasks/public';
const labels = {
  workflow_auto_paused: 'Workflow auto-paused',
  connection_attention: 'Connection needs attention',
  limit_reached: 'Workspace limit reached',
  limit_approaching: 'Workspace nearing a limit',
  approval_waiting: 'Approval waiting',
} as const;
function AttentionLink({
  workspaceId,
  thread,
  onOpen,
}: {
  workspaceId: string;
  thread: WorkspaceInboxAttentionThread;
  onOpen: () => void;
}) {
  const params = { workspaceId };
  if (thread.noticeKind === 'approval_waiting')
    return (
      <Link
        onClick={onOpen}
        to="/w/$workspaceId/approvals/$taskId"
        params={{ ...params, taskId: thread.subjectId }}
      >
        Review approval
      </Link>
    );
  if (thread.noticeKind === 'connection_attention')
    return (
      <Link
        onClick={onOpen}
        to="/w/$workspaceId/connections"
        params={params}
        search={{ connection: thread.subjectId }}
      >
        Open connection
      </Link>
    );
  if (
    thread.noticeKind === 'limit_reached' ||
    thread.noticeKind === 'limit_approaching'
  )
    return (
      <Link
        onClick={onOpen}
        to="/w/$workspaceId/settings/usage"
        params={params}
        search={{ window: '24h' }}
      >
        Review usage
      </Link>
    );
  return (
    <Link
      onClick={onOpen}
      to="/w/$workspaceId/workflows/$workflowId/settings"
      params={{ ...params, workflowId: thread.subjectId }}
    >
      Review workflow
    </Link>
  );
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
  return (
    <li
      data-slot="inbox-thread"
      data-unread={thread.unread ? true : undefined}
      className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 border-b border-border px-3 py-4 sm:grid-cols-[2rem_minmax(0,1fr)_auto]"
    >
      <StatusGlyph
        tone={
          thread.noticeKind === 'approval_waiting' ? 'waiting' : 'attention'
        }
      />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">
          {labels[thread.noticeKind]}
        </p>
        <p className="truncate font-medium">{thread.name}</p>
        {thread.noticeKind === 'approval_waiting' ? (
          <TaskDetails details={thread.details} />
        ) : null}
        {thread.noticeKind === 'limit_approaching' ? (
          <p className="text-sm text-muted-foreground">
            At least 80% of this capacity is in use.
          </p>
        ) : null}
        {thread.limits.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {thread.limits
              .map(
                (limit) =>
                  ({
                    active: 'Active runs',
                    queue: 'Queued runs',
                    artifact_bytes: 'File storage',
                    artifact_count: 'File count',
                  })[limit],
              )
              .join(' · ')}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {formatDateTime(thread.latestOccurredAt)}
        </p>
        <div className="text-sm underline underline-offset-4">
          <AttentionLink
            workspaceId={props.workspaceId}
            thread={thread}
            onOpen={props.onRead}
          />
        </div>
      </div>
      {thread.unread ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={props.marking}
          onClick={props.onRead}
        >
          Mark read
        </Button>
      ) : null}
    </li>
  );
}
