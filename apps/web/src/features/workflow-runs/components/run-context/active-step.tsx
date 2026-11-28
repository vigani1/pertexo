import { QUERY_POLLING } from '@/lib/api/query-timings';
import type { WorkflowRunReadSummary } from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { useStepDescriptions } from '@/features/catalog/public';
import { shownData } from '@/lib/api/error-copy';
import {
  workflowRunQueryOptions,
  workflowRunVersionQueryOptions,
} from '../../data/detail.queries';
import type { RunDataScope } from '../run-detail/data/value';

export function ActiveRunStep({
  run,
  scope,
}: Readonly<{
  run: WorkflowRunReadSummary;
  scope: Omit<RunDataScope, 'runId'>;
}>) {
  const { apiClient, userId, workspace } = scope;
  const active = run.status === 'running' || run.status === 'waiting';
  const canReadGraph = workspace.capabilities.includes('workflow:read');
  const snapshot = useQuery({
    ...workflowRunQueryOptions(apiClient, userId, workspace.id, run.id),
    enabled: active && canReadGraph,
    refetchInterval: QUERY_POLLING.status,
  });
  const version = useQuery({
    ...workflowRunVersionQueryOptions({
      apiClient,
      userId,
      workspaceId: workspace.id,
      workflowId: run.workflowId,
      versionId: run.workflowVersionId,
    }),
    enabled: active && canReadGraph,
  });
  const describe = useStepDescriptions();
  const step = shownData(snapshot)?.nodes.find(
    (node) => node.status === 'running' || node.status === 'waiting',
  );
  const node = shownData(version)?.graph.nodes.find(
    (item) => item.id === step?.nodeId,
  );
  if (!active || !canReadGraph || node === undefined) return null;
  const label = node.label?.trim();
  return (
    <span className="block text-xs text-muted-foreground">
      {label !== undefined && label !== ''
        ? label
        : describe(node.definition).name}
    </span>
  );
}
