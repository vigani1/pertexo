import { InputResponse } from '../components/input-response';
import { TaskDetails } from '../components/details';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  PageHeader,
  PageHeaderMeta,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { QueryView } from '@/components/patterns/states/query-view';
import { Status, StatusGlyph } from '@/components/ui/status';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime, formatRelativeTime } from '@/lib/format/time';
import { taskQueryOptions } from '../data/tasks.queries';
import type { TaskScope } from '../data/tasks.api';
import {
  taskStatusLabel,
  taskTone,
  timedOutAfter,
} from '../model/presentation';
import { DecisionForm } from '../components/decision-form';
import type { PendingTaskDetail } from '@pertexo/contracts';
import { TimedOutGlyph } from '@/features/catalog/presentation.public';
import { useNow } from '@/lib/hooks/use-now';
export function TaskDetailPage({
  scope,
  taskId,
}: Readonly<{ scope: TaskScope; taskId: string }>) {
  const query = useQuery(taskQueryOptions(scope, taskId));
  return (
    <QueryView
      query={query}
      resource="Request"
      loading={<Skeleton className="h-48 w-full" />}
    >
      {({ task }) => {
        return (
          <div className="flex max-w-3xl flex-col gap-8">
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
                  at step{' '}
                  <span className="font-mono text-xs">{task.nodeId}</span>
                </p>
                <PageHeaderTitle className="min-w-0 break-words [overflow-wrap:anywhere]">
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
              className="flex flex-col gap-6 border-l-2 border-action/40 pl-5"
            >
              {task.instructions === '' ? null : (
                <p className="text-lg whitespace-pre-wrap break-words">
                  {task.instructions}
                </p>
              )}
              <TaskDetails details={task.details} />
              <p className="text-sm text-muted-foreground">
                {task.kind === 'approval'
                  ? 'One eligible person approves or rejects this request.'
                  : 'One eligible member responds. The person who started the run may respond.'}
              </p>
            </section>
            {task.kind !== 'approval' || task.output === null ? null : (
              <section className="flex items-start gap-4 rounded-xl border border-border bg-surface-ink/[0.02] p-5">
                <span
                  aria-hidden="true"
                  className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full border border-border"
                >
                  <StatusGlyph tone={taskTone(task.status)} />
                </span>
                <div className="min-w-0">
                  <h2 className="font-medium">
                    {task.completedByName ?? 'Workspace member'}{' '}
                    {task.output.decision} this request
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {formatDateTime(task.output.decidedAt)}
                  </p>
                  {task.output.comment === null ? null : (
                    <p className="mt-3 whitespace-pre-wrap break-words">
                      {task.output.comment}
                    </p>
                  )}
                </div>
              </section>
            )}
            {task.kind === 'approval' ? (
              <DecisionForm key={task.id} task={task} scope={scope} />
            ) : (
              <InputResponse key={task.id} task={task} scope={scope} />
            )}
            <Link
              to="/w/$workspaceId/requests"
              search={{ view: 'mine', status: 'pending' }}
              params={{ workspaceId: scope.workspaceId }}
              className="text-sm underline underline-offset-4"
            >
              Back to requests
            </Link>
          </div>
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
    intervalMs: 60_000,
    enabled: task.status === 'pending',
  });
  const timedOut = timedOutAfter(task);
  const due = (
    <span title={formatDateTime(task.expiresAt)}>
      {task.status === 'pending' ? 'Expires' : 'Was due'}{' '}
      {formatRelativeTime(task.expiresAt, nowMs, 'long')}
    </span>
  );
  if (timedOut !== undefined)
    return (
      <>
        <span className="inline-flex items-center gap-1.5 text-[0.8rem] leading-none font-semibold text-warning">
          <TimedOutGlyph />
          {timedOut}
        </span>
        {due}
      </>
    );
  return (
    <>
      <Status tone={taskTone(task.status)}>
        {taskStatusLabel(task.status)}
      </Status>
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
