import { InputResponse } from '../components/input-response';
import { TaskDetails } from '../components/details';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { ReadFailure } from '@/components/patterns/states/read-failure';
import { Status } from '@/components/ui/status';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime } from '@/lib/format/time';
import { taskQueryOptions } from '../data/tasks.queries';
import type { TaskScope } from '../data/tasks.api';
import { taskTone } from '../model/presentation';
import { DecisionForm } from '../components/decision-form';
export function TaskDetailPage({
  scope,
  taskId,
}: Readonly<{ scope: TaskScope; taskId: string }>) {
  const query = useQuery(taskQueryOptions(scope, taskId));
  if (query.isPending) return <Skeleton className="h-48 w-full" />;
  if (query.isError)
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
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader>
        <PageHeaderTitle className="min-w-0 break-words [overflow-wrap:anywhere]">
          {task.title}
        </PageHeaderTitle>
        <Status tone={taskTone(task.status)}>{task.status}</Status>
      </PageHeader>
      <div className="rounded-xl border border-border p-5">
        <p className="break-words text-sm text-muted-foreground">
          {task.workflowName} · {task.nodeId}
        </p>
        <Link
          to="/w/$workspaceId/runs/$runId"
          params={{ workspaceId: task.workspaceId, runId: task.runId }}
          className="mt-2 inline-block text-sm underline underline-offset-4"
        >
          Open run
        </Link>
        <p className="mt-3 text-sm text-muted-foreground">
          Expires {formatDateTime(task.expiresAt)}.{' '}
          {task.kind === 'approval'
            ? 'One eligible person decides; the starter cannot decide.'
            : 'One eligible member responds. The person who started the run may respond.'}
        </p>
        {task.instructions === '' ? null : (
          <p className="mt-4 whitespace-pre-wrap break-words">
            {task.instructions}
          </p>
        )}
        <TaskDetails details={task.details} />
      </div>
      {task.kind !== 'approval' || task.output === null ? null : (
        <section className="rounded-xl border border-border p-5">
          <h2 className="font-medium">
            {task.completedByName ?? 'Workspace member'} {task.output.decision}{' '}
            this request
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDateTime(task.output.decidedAt)}
          </p>
          {task.output.comment === null ? null : (
            <p className="mt-3 whitespace-pre-wrap break-words">
              {task.output.comment}
            </p>
          )}
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
