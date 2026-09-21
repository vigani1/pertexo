import type { WorkflowRunReadSummary } from '@pertexo/contracts/schemas/workflow-runs';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function RunHistoryTable({
  runs,
  workspaceId,
}: Readonly<{
  runs: readonly WorkflowRunReadSummary[];
  workspaceId: string;
}>) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Run</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Trigger</TableHead>
          <TableHead>Workflow version</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead className="text-right">Details</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id}>
            <TableCell>
              <span
                className="block max-w-64 truncate font-medium"
                title={run.workflowName ?? 'Workflow name unavailable'}
              >
                {run.workflowName ?? 'Workflow name unavailable'}
              </span>
              <span className="sr-only">{run.id}</span>
              <span
                className="mt-1 block max-w-48 truncate font-mono text-[0.68rem] text-muted-foreground"
                title={`Run ${run.id}; workflow ${run.workflowId}`}
              >
                Run {shortId(run.id)} · Workflow {shortId(run.workflowId)}
              </span>
            </TableCell>
            <TableCell>
              <Badge variant={statusVariant(run.status)}>
                {run.status.replaceAll('_', ' ')}
              </Badge>
            </TableCell>
            <TableCell className="capitalize text-muted-foreground">
              {run.triggerType}
            </TableCell>
            <TableCell>
              <span
                className="block max-w-44 truncate font-mono text-xs text-muted-foreground"
                title={run.workflowVersionId}
              >
                {run.workflowVersionId}
              </span>
            </TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">
              {dateFormatter.format(new Date(run.createdAt))}
            </TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">
              {duration(run)}
            </TableCell>
            <TableCell className="text-right">
              <Link
                to="/w/$workspaceId/runs/$runId"
                params={{ workspaceId, runId: run.id }}
                aria-label={`Open run ${run.id}`}
                className="inline-flex h-8 items-center gap-1 rounded-lg px-3 text-sm font-medium text-foreground hover:bg-white/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                Open
                <ArrowRightIcon aria-hidden="true" />
              </Link>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

function statusVariant(
  status: WorkflowRunReadSummary['status'],
): 'default' | 'secondary' | 'muted' | 'destructive' {
  if (status === 'succeeded') return 'default';
  if (status === 'failed' || status === 'timed_out') return 'destructive';
  if (status === 'running' || status === 'waiting') return 'secondary';
  return 'muted';
}

function duration(run: WorkflowRunReadSummary): string {
  if (run.startedAt === null || run.completedAt === null) return '—';
  const milliseconds = Date.parse(run.completedAt) - Date.parse(run.startedAt);
  if (milliseconds < 1_000) return `${String(milliseconds)} ms`;
  if (milliseconds < 60_000)
    return `${String(Math.round(milliseconds / 1_000))} s`;
  return `${String(Math.round(milliseconds / 60_000))} min`;
}
