import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { PendingTaskDetail } from '@pertexo/contracts';
import { useStepDescriptions } from '@/features/catalog/public';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import { QueryView } from '@/components/patterns/states/query-view';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { buildRunTimeline } from '../../model/timeline/runs';
import {
  workflowRunQueryOptions,
  workflowRunVersionQueryOptions,
} from '../../data/detail.queries';
import type { RunDataScope } from '../run-detail/data/value';

export function ApprovalRunThread({
  scope,
  task,
}: Readonly<{
  scope: Omit<RunDataScope, 'runId'>;
  task: Extract<PendingTaskDetail, { kind: 'approval' }>;
}>) {
  const { apiClient, userId, workspace } = scope;
  const run = useQuery(
    workflowRunQueryOptions(apiClient, userId, workspace.id, task.runId),
  );
  const version = useQuery({
    ...workflowRunVersionQueryOptions({
      apiClient,
      userId,
      workspaceId: workspace.id,
      workflowId: task.workflowId,
      versionId: task.workflowVersionId,
    }),
    enabled: workspace.capabilities.includes('workflow:read'),
  });
  const describe = useStepDescriptions();
  return (
    <section aria-labelledby="approval-run-thread" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <RuleHeading id="approval-run-thread">So far in this run</RuleHeading>
        <Link
          to="/w/$workspaceId/runs/$runId"
          params={{ workspaceId: workspace.id, runId: task.runId }}
          className="inline-flex items-center text-sm text-accent-foreground underline-offset-4 hover:underline pointer-coarse:min-h-10"
        >
          Open the run
        </Link>
      </div>
      <QueryView query={run} resource="The run thread">
        {(snapshot) => {
          const { rows } = buildRunTimeline(
            {
              run: snapshot.run,
              nodes: snapshot.nodes,
              events: [],
              nowMs: Date.parse(task.createdAt),
              ...(version.data === undefined
                ? {}
                : { graph: version.data.graph }),
            },
            describe,
          );
          const earlier = rows
            .filter(
              (row) =>
                row.completedAt !== undefined &&
                Date.parse(row.completedAt) <= Date.parse(task.createdAt),
            )
            .slice(-4);
          return (
            <ol className="flex flex-wrap gap-x-4 gap-y-2 rounded-lg bg-select p-3 text-sm">
              {earlier.map((row) => (
                <li key={row.key} className="inline-flex items-center gap-1.5">
                  <StatusMark display="mark" tone={row.tone} />
                  {row.label}
                </li>
              ))}
              <li className="inline-flex items-center gap-1.5">
                <StatusMark
                  display="mark"
                  tone={task.status === 'pending' ? 'waiting' : 'off'}
                />
                {task.stepName ?? 'Approval'}
              </li>
            </ol>
          );
        }}
      </QueryView>
    </section>
  );
}
