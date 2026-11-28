import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import type { ReactNode } from 'react';
import { ApprovalPosition } from '../components/approval-position';
import { InputResponse } from '../components/input-response';
import { TaskDetails } from '../components/task-details';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  PageHeader,
  PageHeaderMeta,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { QueryView } from '@/components/patterns/states/query-view';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime, formatRelativeTime } from '@/lib/format/time';
import { taskQueryOptions } from '../data/tasks.queries';
import type { TaskScope } from '../data/tasks.api';
import {
  audienceSentence,
  taskStatusLabel,
  taskTone,
  timedOutAfter,
} from '../model/task-presentation';
import { DecisionForm } from '../components/decision-form';
import type {
  PendingTaskDetail,
  PendingTaskListQuery,
} from '@pertexo/contracts';
import { TimedOutGlyph } from '@/components/patterns/dates/timed-out-glyph';
import { CLOCK_TICK, useNow } from '@/lib/hooks/use-now';
export function TaskDetailPage({
  scope,
  taskId,
  queueView,
  renderRunThread,
}: Readonly<{
  scope: TaskScope;
  taskId: string;
  queueView: PendingTaskListQuery['view'];
  renderRunThread: (
    task: Extract<PendingTaskDetail, { kind: 'approval' }>,
  ) => ReactNode;
}>) {
  const query = useQuery(taskQueryOptions(scope, taskId));
  return (
    <QueryView
      query={query}
      resource="Request"
      loading={<Skeleton className="h-48 w-full" />}
    >
      {({ task }) => {
        return (
          <article className="flex max-w-3xl min-w-0 flex-col gap-4 md:gap-6">
            <PageHeader>
              <div className="flex min-w-0 flex-col gap-2">
                <p className="text-sm text-muted-foreground">
                  {task.kind === 'approval' ? 'Approval' : 'Input'} requested by{' '}
                  <Link
                    to="/w/$workspaceId/runs/$runId"
                    params={{
                      workspaceId: task.workspaceId,
                      runId: task.runId,
                    }}
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    {task.workflowName}
                  </Link>{' '}
                  {task.stepName === null ? null : (
                    <> at step {task.stepName}</>
                  )}
                </p>
                <PageHeaderTitle
                  size="detail"
                  className="min-w-0 break-words [overflow-wrap:anywhere]"
                >
                  {task.title}
                </PageHeaderTitle>
                <PageHeaderMeta>
                  <TaskStatusLine task={task} />
                </PageHeaderMeta>
              </div>
            </PageHeader>
            {/* The brief: what the workflow asks, then what it knows. */}
            <section
              aria-label="What is being asked"
              className="flex min-w-0 flex-col gap-4"
            >
              {task.instructions === '' ? null : (
                <p className="text-base whitespace-pre-wrap md:text-lg break-words">
                  {task.instructions}
                </p>
              )}
              {Object.keys(task.details).length > 0 ? (
                <div className="grid gap-3 rounded-lg border border-border p-4">
                  <h2 className="font-medium">The request</h2>
                  <TaskDetails details={task.details} />
                </div>
              ) : null}
            </section>
            {task.kind === 'approval' ? renderRunThread(task) : null}
            {task.kind !== 'approval' || task.output === null ? null : (
              <section aria-labelledby="task-decision" className="grid gap-2">
                <RuleHeading id="task-decision">
                  <StatusMark display="mark" tone={taskTone(task.status)} />
                  {task.completedByName ?? 'Workspace member'}{' '}
                  {task.output.decision} this request
                </RuleHeading>
                <p className="font-mono text-meta text-subtle-foreground">
                  {formatDateTime(task.output.decidedAt)}
                </p>
                {task.output.comment === null ? null : (
                  <p className="whitespace-pre-wrap break-words">
                    {task.output.comment}
                  </p>
                )}
              </section>
            )}
            {task.kind === 'approval' && task.status === 'pending' ? (
              <section
                className="grid gap-2"
                aria-labelledby="approval-outcomes"
              >
                <RuleHeading id="approval-outcomes">
                  What each answer does
                </RuleHeading>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                  <dt className="font-medium">Approve</dt>
                  <dd className="text-muted-foreground">
                    The run carries on along the step’s Approved path.
                  </dd>
                  <dt className="font-medium">Reject</dt>
                  <dd className="text-muted-foreground">
                    The run carries on along the step’s Rejected path.
                  </dd>
                  <dt className="font-medium">No answer</dt>
                  <dd className="text-muted-foreground">
                    At{' '}
                    <time dateTime={task.expiresAt}>
                      {formatDateTime(task.expiresAt)}
                    </time>
                    ,{' '}
                    {task.onExpiry === 'continue'
                      ? 'the run carries on along the Timed out path.'
                      : 'this step fails. A failure route takes over if the workflow has one.'}
                  </dd>
                </dl>
              </section>
            ) : null}
            <section aria-labelledby="task-audience" className="grid gap-2">
              <RuleHeading id="task-audience">
                {task.kind === 'approval' ? 'Who decides' : 'Who responds'}
              </RuleHeading>
              <p className="text-sm text-muted-foreground">
                {audienceSentence(task)}
                {task.canRespond ? ' You can answer it.' : null}
              </p>
            </section>
            {task.kind === 'approval' ? (
              <DecisionForm
                key={task.id}
                task={task}
                scope={scope}
                queueNavigation={
                  <ApprovalPosition
                    scope={scope}
                    taskId={task.id}
                    view={queueView}
                  />
                }
              />
            ) : (
              <InputResponse key={task.id} task={task} scope={scope} />
            )}
          </article>
        );
      }}
    </QueryView>
  );
}

/**
 * Where the request stands: its status, then a calm countdown while it
 * waits, "Timed out after 7 days" once its run moved on without an answer,
 * or when it was due.
 */
function TaskStatusLine({ task }: Readonly<{ task: PendingTaskDetail }>) {
  // The countdown reads "in 2 days"; a minute's tick keeps it honest.
  const nowMs = useNow({
    intervalMs: CLOCK_TICK.relativeTime,
    enabled: task.status === 'pending',
  });
  const timedOut = timedOutAfter(task);
  const expiry =
    task.onExpiry === 'continue'
      ? ', then takes the Timed out path'
      : ', then the step fails';
  const due = (
    <span title={formatDateTime(task.expiresAt)}>
      {task.status === 'pending' ? 'Expires' : 'Was due'}{' '}
      {formatRelativeTime(task.expiresAt, nowMs, 'long')}
      {task.status === 'pending' && task.kind === 'approval' ? expiry : null}
    </span>
  );
  if (timedOut !== undefined)
    return (
      <>
        <StatusMark tone="attention">{timedOut}</StatusMark>
        {due}
      </>
    );
  return (
    <>
      <StatusMark tone={taskTone(task.status)}>
        {taskStatusLabel(task.status)}
      </StatusMark>
      {task.status === 'pending' ? (
        <span className="inline-flex items-center gap-1.5">
          <TimedOutGlyph className="size-3.5 text-subtle-foreground" />
          {due}
        </span>
      ) : (
        due
      )}
    </>
  );
}
