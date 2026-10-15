import type { PendingTaskSummary } from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { Status } from '@/components/ui/status';
import { formatDateTime } from '@/lib/format/time';
import { taskTone } from '../model/presentation';
export function TaskRow({ task }: Readonly<{ task: PendingTaskSummary }>) {
  return (
    <li className="flex items-start gap-3 border-b border-border py-4">
      <span className="mt-1 h-10 w-px shrink-0 bg-border" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <Link
          to="/w/$workspaceId/requests/$taskId"
          params={{ workspaceId: task.workspaceId, taskId: task.id }}
          className="break-words font-medium text-foreground underline-offset-4 hover:underline"
        >
          {task.title}
        </Link>
        <p className="mt-1 break-words text-sm text-muted-foreground">
          {task.workflowName} · {task.nodeId}
          {task.iterationPath
            .map((item) => ` · item ${String(item.ordinal + 1)}`)
            .join('')}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {task.status === 'pending'
            ? `Expires ${formatDateTime(task.expiresAt)}`
            : `Resolved ${formatDateTime(task.completedAt ?? task.createdAt)}`}
        </p>
      </div>
      <Status tone={taskTone(task.status)}>{task.status}</Status>
    </li>
  );
}
