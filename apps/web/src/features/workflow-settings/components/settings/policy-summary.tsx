import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { holdsCapability } from '@/features/workspaces/workspaces-routing.public';
import type { ApiClient } from '@/lib/api/client';
import { shownData } from '@/lib/api/error-copy';
import { workflowAutoPauseQueryOptions } from '../../data/auto-pause.queries';
import { concurrencyQueryOptions } from '../../data/concurrency.queries';
import { errorWorkflowQuery } from '../../data/error-workflow/error-workflow.queries';
import {
  failureNotificationPolicyQueryOptions,
  workflowVersionsQueryOptions,
} from '../../data/workflow-settings.queries';
import {
  describeRunDuration,
  maxRunDurationOf,
} from '../../model/run-duration';

export function WorkflowPolicySummary({
  apiClient,
  userId,
  workspace,
  workflow,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
}>) {
  const scope = [apiClient, userId, workspace.id, workflow.id] as const;
  const versions = useQuery({
    ...workflowVersionsQueryOptions(...scope),
    enabled: workflow.publishedVersionId !== null,
  });
  const canRead = holdsCapability(workspace, 'workflow:read');
  const concurrency = shownData(
    useQuery({ ...concurrencyQueryOptions(...scope), enabled: canRead }),
  );
  const pause = shownData(useQuery(workflowAutoPauseQueryOptions(...scope)));
  const alerts = shownData(
    useQuery({
      ...failureNotificationPolicyQueryOptions(...scope),
      enabled: holdsCapability(workspace, 'workflow:update'),
    }),
  );
  const errorRoute = shownData(
    useQuery({
      ...errorWorkflowQuery(...scope),
      enabled: canRead,
    }),
  );
  const live = shownData(versions)?.items.find(
    ({ id }) => id === workflow.publishedVersionId,
  );
  const duration =
    live === undefined ? undefined : maxRunDurationOf(live.graph);
  const lines: string[] = [];
  if (live !== undefined)
    lines.push(
      duration === undefined
        ? 'The published version has no run time limit.'
        : `Runs stop after ${describeRunDuration(duration)}.`,
    );
  if (concurrency?.limit != null)
    lines.push(`Up to ${String(concurrency.limit)} runs at a time.`);
  if (alerts !== undefined)
    lines.push(
      alerts.destination?.status === 'enabled'
        ? 'Failure alerts are on.'
        : 'Failure alerts are off.',
    );
  if (errorRoute?.targetWorkflowId != null)
    lines.push(
      `Failure starts ${errorRoute.targetWorkflowName ?? 'an error workflow'}.`,
    );
  if (pause !== undefined)
    lines.push(
      pause.enabled
        ? `${String(pause.effectiveThreshold)} failures in a row pause triggers.`
        : 'Automatic pause is off.',
    );
  if (lines.length === 0) return null;
  return <p className="text-meta text-muted-foreground">{lines.join(' ')}</p>;
}
