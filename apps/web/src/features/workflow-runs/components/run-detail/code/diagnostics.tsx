import { useQuery } from '@tanstack/react-query';
import { CodeDiagnostics } from '@/components/patterns/code/diagnostics';
import {
  InlineFailedRead,
  QueryView,
} from '@/components/patterns/states/query-view';
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
    ...nodeRunDiagnosticsQueryOptions({
      apiClient: scope.apiClient,
      userId: scope.userId,
      workspaceId: scope.workspace.id,
      runId: scope.runId,
      step: {
        nodeRunId: row.nodeRunId ?? '',
        attemptNumber: row.currentAttemptNumber,
        status: row.status,
      },
    }),
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
  return (
    <QueryView
      query={query}
      resource="Code diagnostics"
      loading={<SkeletonLines label="Loading Code diagnostics" />}
      error={(failed) => (
        <InlineFailedRead text="Couldn’t load Code diagnostics." {...failed} />
      )}
    >
      {(diagnostics) =>
        diagnostics === null ? (
          <p className="text-xs text-muted-foreground">
            No Code diagnostics were kept for this attempt. Run details expire
            after 30 days.
          </p>
        ) : (
          <CodeDiagnostics diagnostics={diagnostics} />
        )
      }
    </QueryView>
  );
}
