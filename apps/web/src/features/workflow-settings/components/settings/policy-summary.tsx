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
  const lines = [
    live === undefined
      ? undefined
      : duration === undefined
        ? 'The published version has no run time limit.'
        : `Runs stop after ${describeRunDuration(duration)}.`,
    concurrency?.limit == null
      ? undefined
      : `Up to ${String(concurrency.limit)} runs at a time.`,
    alerts === undefined
      ? undefined
      : alerts.destination === null
        ? 'Failure alerts are off.'
        : 'Failure alerts are on.',
    errorRoute?.targetWorkflowId == null
      ? undefined
      : `Failure starts ${errorRoute.targetWorkflowName ?? 'an error workflow'}.`,
    pause === undefined
      ? undefined
      : pause.enabled
        ? `${String(pause.effectiveThreshold)} failures in a row pause triggers.`
        : 'Automatic pause is off.',
  ].filter((line) => line !== undefined);
  if (lines.length === 0) return null;
  return <p className="text-meta text-muted-foreground">{lines.join(' ')}</p>;
}
