import { InputResponse } from '../components/input-response';
import { TaskDetails } from '../components/details';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  PageHeader,
  PageHeaderMeta,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { ReadFailure } from '@/components/patterns/states/read-failure';
import { Status, StatusGlyph } from '@/components/ui/status';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime, formatRelativeTime } from '@/lib/format/time';
import { taskQueryOptions } from '../data/tasks.queries';
import type { TaskScope } from '../data/tasks.api';
import { taskStatusLabel, taskTone } from '../model/presentation';
import { DecisionForm } from '../components/decision-form';
export function TaskDetailPage({
  scope,
  taskId,
}: Readonly<{ scope: TaskScope; taskId: string }>) {
  const query = useQuery(taskQueryOptions(scope, taskId));
  if (query.isPending) return <Skeleton className="h-48 w-full" />;
  if (query.data === undefined)
    return (
      <ReadFailure
        resource="Request"
        error={query.error}
        showing={false}
        retrying={query.isFetching}
        updatedAt={query.dataUpdatedAt}
        onRetry={() => void query.refetch()}
      />
    );
  const { task } = query.data;
  const waiting = task.status === 'pending';
  return (
    <div className="flex max-w-3xl flex-col gap-8">
      {query.isError ? (
        <ReadFailure
          resource="Request"
          error={query.error}
          showing
          retrying={query.isFetching}
          updatedAt={query.dataUpdatedAt}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      <PageHeader>
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            {task.kind === 'approval' ? 'Approval' : 'Input'} requested by{' '}
            <Link
              to="/w/$workspaceId/runs/$runId"
              params={{ workspaceId: task.workspaceId, runId: task.runId }}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {task.workflowName}
            </Link>{' '}
            at step <span className="font-mono text-xs">{task.nodeId}</span>
          </p>
          <PageHeaderTitle className="min-w-0 break-words [overflow-wrap:anywhere]">
            {task.title}
          </PageHeaderTitle>
          <PageHeaderMeta>
            <Status tone={taskTone(task.status)}>
              {taskStatusLabel(task.status)}
            </Status>
            <span title={formatDateTime(task.expiresAt)}>
              {waiting ? 'expires' : 'was due'}{' '}
              {formatRelativeTime(task.expiresAt)}
            </span>
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
}
