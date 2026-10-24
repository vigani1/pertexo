import type { WorkspaceInboxFailureThread } from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { CheckIcon, HistoryIcon } from 'lucide-react';
import { describeInboxThread } from '../../model/inbox-thread.js';
import { FailureLane } from './failure-lane';
import { NoticeAction, NoticeFrame } from './frame';
import { noticeLinkClass } from './link-class';

/**
 * One failing workflow: what went wrong on one line and its last 30 days as
 * a strip beside it. The whole row opens the latest run and marks the
 * notice read; run history and "Mark read" sit above that link.
 */
export function InboxThreadRow({
  workspaceId,
  thread,
  nowMs,
  marking,
  onRead,
}: Readonly<{
  workspaceId: string;
  thread: WorkspaceInboxFailureThread;
  nowMs: number;
  marking: boolean;
  onRead: () => void;
}>) {
  const view = describeInboxThread(thread);
  return (
    <NoticeFrame
      unread={thread.unread}
      occurredAt={thread.latestOccurredAt}
      nowMs={nowMs}
      title={
        <Link
          to="/w/$workspaceId/runs/$runId"
          params={{ workspaceId, runId: thread.latestRunId }}
          onClick={onRead}
          {...(thread.unread
            ? { 'aria-label': `${thread.workflowName}, unread` }
            : {})}
          className={noticeLinkClass({ unread: thread.unread })}
        >
          {thread.workflowName}
        </Link>
      }
      summary={
        <>
          {view.occurrences}
          {view.step === undefined ? null : (
            <>
              {' · at '}
              <span className="text-foreground">{view.step}</span>
            </>
          )}
          {view.reason === undefined ? null : ` · ${view.reason}`}
        </>
      }
      aside={<FailureLane days={thread.failureDays} nowMs={nowMs} />}
      actions={
        <>
          <NoticeAction
            label="Run history"
            name={`Run history of ${thread.workflowName}`}
            render={
              <Link
                to="/w/$workspaceId/workflows/$workflowId/runs"
                params={{ workspaceId, workflowId: thread.workflowId }}
              />
            }
          >
            <HistoryIcon aria-hidden="true" />
          </NoticeAction>
          {thread.unread ? (
            <NoticeAction
              label="Mark read"
              name={`Mark ${thread.workflowName} read`}
              render={
                <button type="button" disabled={marking} onClick={onRead} />
              }
            >
              <CheckIcon aria-hidden="true" />
            </NoticeAction>
          ) : null}
        </>
      }
      status={{ tone: view.look.tone, word: view.look.label }}
    />
  );
}
