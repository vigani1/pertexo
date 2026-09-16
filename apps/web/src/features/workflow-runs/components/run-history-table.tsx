import type { WorkflowRunSummary } from '@pertexo/contracts/schemas/workflow-runs';
import { ArrowRightIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  onOpenRun,
}: Readonly<{
  runs: readonly WorkflowRunSummary[];
  onOpenRun: (runId: string) => void;
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
                className="block max-w-48 truncate font-mono text-xs"
                title={run.id}
              >
                {run.id}
              </span>
              <span
                className="mt-1 block max-w-48 truncate font-mono text-[0.68rem] text-muted-foreground"
                title={run.workflowId}
              >
                Workflow {run.workflowId}
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Open run ${run.id}`}
                onClick={() => {
                  onOpenRun(run.id);
                }}
              >
                Open
                <ArrowRightIcon aria-hidden="true" />
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function statusVariant(
  status: WorkflowRunSummary['status'],
): 'default' | 'secondary' | 'muted' | 'destructive' {
  if (status === 'succeeded') return 'default';
  if (status === 'failed' || status === 'timed_out') return 'destructive';
  if (status === 'running' || status === 'waiting') return 'secondary';
  return 'muted';
}

function duration(run: WorkflowRunSummary): string {
  if (run.startedAt === null || run.completedAt === null) return '—';
  const milliseconds = Date.parse(run.completedAt) - Date.parse(run.startedAt);
  if (milliseconds < 1_000) return `${String(milliseconds)} ms`;
  if (milliseconds < 60_000)
    return `${String(Math.round(milliseconds / 1_000))} s`;
  return `${String(Math.round(milliseconds / 60_000))} min`;
}
