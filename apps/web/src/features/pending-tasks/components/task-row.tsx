import type { PendingTaskSummary } from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { StatusGlyph } from '@/components/ui/status';
import { statusToneText } from '@/components/ui/status-tone';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  formatDateTime,
  formatElapsedTime,
  formatRelativeTime,
} from '@/lib/format/time';
import { cn } from '@/lib/utils';
import type { TaskScope } from '../data/tasks.api';
import {
  blockedLabel,
  taskOutcome,
  taskStatusLabel,
  taskTone,
} from '../model/presentation';
import { TaskDetailsLine } from './details';
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
}: Readonly<{ scope: TaskScope; task: PendingTaskSummary; nowMs: number }>) {
  const tone = taskTone(task.status);
  const waiting = task.status === 'pending';
  const yours = waiting && task.canRespond;
  const blocked = waiting ? blockedLabel(task.blockedReason) : undefined;
  const when = waiting ? task.expiresAt : (task.completedAt ?? task.createdAt);
  return (
    <li className="group/row row-divider grid grid-cols-[2rem_minmax(0,1fr)] items-start gap-x-4 gap-y-3 rounded-lg px-3 py-4 transition-colors hover:bg-surface-ink/[0.035] motion-reduce:transition-none sm:grid-cols-[2rem_minmax(0,1fr)_auto]">
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 grid size-8 place-items-center rounded-full border transition-colors',
          yours
            ? 'border-action/60 bg-action/[0.07] shadow-[0_0_0_4px_color-mix(in_srgb,var(--action)_10%,transparent)]'
            : 'border-border bg-surface-ink/[0.02]',
        )}
      >
        <StatusGlyph tone={tone} />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link
            to="/w/$workspaceId/requests/$taskId"
            params={{ workspaceId: task.workspaceId, taskId: task.id }}
            className={cn(
              "min-w-0 break-words outline-none after:absolute after:inset-0 after:rounded-lg after:content-[''] hover:text-accent-foreground focus-visible:after:ring-2 focus-visible:after:ring-ring/60",
              yours ? 'font-semibold text-foreground' : 'font-medium',
            )}
          >
            {task.title}
          </Link>
          <span
            className={cn('text-[0.78rem] font-medium', statusToneText[tone])}
          >
            {waiting ? taskStatusLabel(task.status) : taskOutcome(task)}
          </span>
        </div>
        <p className="min-w-0 break-words text-sm text-muted-foreground">
          {task.kind === 'approval' ? 'Approval' : 'Input'} ·{' '}
          {task.workflowName} · {task.nodeId}
          {task.iterationPath
            .map((item) => ` · item ${String(item.ordinal + 1)}`)
            .join('')}
        </p>
        <TaskDetailsLine details={task.details} />
      </div>
      {/* Below the request on a phone, beside it on wider screens. */}
      <div className="relative z-10 col-start-2 flex flex-col items-start gap-2 sm:col-start-3 sm:row-start-1 sm:items-end">
        <TaskAction scope={scope} task={task} yours={yours} blocked={blocked} />
        <time
          dateTime={when}
          title={formatDateTime(when)}
          className="font-mono text-xs text-subtle-foreground"
        >
          {waiting
            ? `expires ${formatRelativeTime(when, nowMs)}`
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
}: Readonly<{
  scope: TaskScope;
  task: PendingTaskSummary;
  yours: boolean;
  blocked: string | undefined;
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
      className={buttonVariants({ size: 'sm' })}
    >
      Respond
    </Link>
  );
}
