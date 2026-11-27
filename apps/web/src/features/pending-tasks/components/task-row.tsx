import type {
  PendingTaskListQuery,
  PendingTaskSummary,
} from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  formatDateTime,
  formatElapsedTime,
  formatRelativeTime,
} from '@/lib/format/time';
import { cn } from '@/lib/class-names';
import type { TaskScope } from '../data/tasks.api';
import {
  blockedLabel,
  taskOutcome,
  taskStatusLabel,
  taskTone,
  timedOutAfter,
} from '../model/task-presentation';
import { TaskDetailsLine } from './task-details';
import { QuickDecision } from './quick-decision';

/**
 * One request in the queue: a ring lit while it waits for you, what it asks
 * and where it came from, its details on a line, and the next step in place.
 * The whole row opens the request; its actions sit above that link.
 */
export function TaskRow({
  scope,
  task,
  nowMs,
  selected,
  inDetail,
  search,
}: Readonly<{
  scope: TaskScope;
  task: PendingTaskSummary;
  nowMs: number;
  selected: boolean;
  inDetail: boolean;
  search: Pick<PendingTaskListQuery, 'kind' | 'view' | 'status'> | undefined;
}>) {
  const timedOut = timedOutAfter(task) !== undefined;
  // A request that moved its run on along Timed out reads amber, not failed.
  const tone = timedOut ? 'attention' : taskTone(task.status);
  const waiting = task.status === 'pending';
  const yours = waiting && task.canRespond;
  const blocked = waiting ? blockedLabel(task.blockedReason) : undefined;
  const when = waiting ? task.expiresAt : (task.completedAt ?? task.createdAt);
  return (
    <li
      className={cn(
        'group/row row-divider grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 rounded-lg px-3 py-2.5 hover:bg-select',
        !inDetail && 'sm:grid-cols-[1.25rem_minmax(0,1fr)_auto]',
        selected && 'bg-select-raised',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 grid size-5 place-items-center rounded-sm',
          yours ? 'bg-select-raised' : undefined,
        )}
      >
        <StatusMark display="mark" tone={tone} />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link
            to="/w/$workspaceId/requests/$taskId"
            params={{ workspaceId: task.workspaceId, taskId: task.id }}
            {...(search === undefined ? {} : { search })}
            aria-current={selected ? 'page' : undefined}
            className={cn(
              "min-w-0 break-words outline-none after:absolute after:inset-0 after:rounded-lg after:content-[''] hover:text-accent-foreground focus-visible:after:ring-2 focus-visible:after:ring-ring/60",
              yours ? 'font-semibold text-foreground' : 'font-medium',
            )}
          >
            {task.title}
          </Link>
          <span className="text-label font-medium text-muted-foreground">
            {waiting ? taskStatusLabel(task.status) : taskOutcome(task)}
          </span>
        </div>
        <p className="min-w-0 break-words text-sm text-muted-foreground">
          {task.kind === 'approval' ? 'Approval' : 'Input'} ·{' '}
          {task.workflowName}
          {task.stepName === null ? '' : ` · ${task.stepName}`}
          {task.iterationPath
            .map((item) => ` · item ${String(item.ordinal + 1)}`)
            .join('')}
        </p>
        {inDetail ? null : <TaskDetailsLine details={task.details} />}
      </div>
      {/* Below the request on a phone, beside it on wider screens. */}
      <div
        className={cn(
          'relative z-10 col-start-2 flex flex-col items-start gap-1',
          !inDetail && 'sm:col-start-3 sm:row-start-1 sm:items-end',
        )}
      >
        {inDetail ? null : (
          <TaskAction
            scope={scope}
            task={task}
            yours={yours}
            blocked={blocked}
            search={search}
          />
        )}
        <time
          dateTime={when}
          title={formatDateTime(when)}
          className="font-mono text-xs text-subtle-foreground"
        >
          {waiting
            ? `expires ${formatRelativeTime(when, nowMs, 'long')}`
            : formatElapsedTime(when, nowMs)}
        </time>
      </div>
    </li>
  );
}

function TaskAction({
  scope,
  task,
  yours,
  blocked,
  search,
}: Readonly<{
  scope: TaskScope;
  task: PendingTaskSummary;
  yours: boolean;
  blocked: string | undefined;
  search: Pick<PendingTaskListQuery, 'kind' | 'view' | 'status'> | undefined;
}>) {
  if (!yours) {
    if (blocked === undefined) return null;
    return (
      <p className="text-xs text-subtle-foreground sm:text-right">{blocked}</p>
    );
  }
  if (task.kind === 'approval')
    return <QuickDecision scope={scope} task={task} />;
  return (
    <Link
      to="/w/$workspaceId/requests/$taskId"
      params={{ workspaceId: task.workspaceId, taskId: task.id }}
      {...(search === undefined ? {} : { search })}
      className={buttonVariants({ size: 'sm' })}
    >
      Respond
    </Link>
  );
}
