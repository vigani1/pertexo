import { useQuery } from '@tanstack/react-query';
import { CodeDiagnostics } from '@/components/patterns/code/diagnostics';
import { Button } from '@/components/ui/button';
import { SkeletonLines } from '@/components/ui/skeleton';
import { nodeRunDiagnosticsQueryOptions } from '../../../data/stored-values.queries';
import type { RunTimelineRow } from '../../../model/timeline/runs';
import type { RunDataScope } from '../data';

export function StepCodeDiagnostics({
  row,
  scope,
}: Readonly<{ row: RunTimelineRow; scope: RunDataScope }>) {
  const settled =
    row.status === 'succeeded' ||
    row.status === 'failed' ||
    row.status === 'canceled' ||
    row.status === 'outcome_unknown';
  const query = useQuery({
    ...nodeRunDiagnosticsQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspace.id,
      scope.runId,
      {
        nodeRunId: row.nodeRunId ?? '',
        attemptNumber: row.currentAttemptNumber,
        status: row.status,
      },
    ),
    enabled: row.nodeRunId !== undefined && row.reused === undefined && settled,
  });
  if (row.reused !== undefined)
    return (
      <p className="text-xs text-muted-foreground">
        Code wasn’t executed: this step used its saved output.
      </p>
    );
  if (!settled || row.nodeRunId === undefined)
    return (
      <p className="text-xs text-muted-foreground">
        Console output appears when this Code attempt finishes.
      </p>
    );
  if (query.data !== undefined)
    return query.data === null ? (
      <p className="text-xs text-muted-foreground">
        No Code diagnostics were kept for this attempt. Run details expire after
        30 days.
      </p>
    ) : (
      <CodeDiagnostics diagnostics={query.data} />
    );
  if (query.isError)
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        Couldn’t load Code diagnostics.
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  return <SkeletonLines label="Loading Code diagnostics" />;
}
