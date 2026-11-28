import { tasksQueryOptions } from '@/features/pending-tasks/pending-tasks-queries.public';
import { shownData } from '@/lib/api/error-copy';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  attentionRunsQueryOptions,
  runStatisticsQueryOptions,
} from '@/features/workflow-runs/workflow-runs-queries.public';
import { workflowsInfiniteQueryOptions } from '@/features/workflows/workflows-queries.public';
import type { ApiClient } from '@/lib/api/client';
import {
  taskAttentionItems,
  connectionAttentionItems,
  destinationAttentionItems,
  runAttentionItems,
  withRunFailure,
  workflowAttentionItems,
} from '../model/needs-attention';
import { mergedBlockState, type BlockQuery } from '../model/home-block-state';
import { NeedsAttention } from './needs-attention';
import { COLLAPSED_LIST_COUNT } from '@/components/patterns/lists/show-all';
import { useRunFailures } from '../hooks/use-run-failures';
import { useSetupReads } from '../hooks/use-setup-reads';

/** Reads everything "Needs attention" is derived from, per capability. */
export function AttentionSection({
  apiClient,
  userId,
  workspace,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
}>) {
  const can = (capability: AccessibleWorkspace['capabilities'][number]) =>
    workspace.capabilities.includes(capability);
  const statistics = useQuery({
    ...runStatisticsQueryOptions(apiClient, userId, workspace.id),
    enabled: can('run:read'),
  });
  const snapshot = can('run:read') ? shownData(statistics) : undefined;
  const runs = useQuery(
    attentionRunsQueryOptions(apiClient, userId, workspace.id, snapshot),
  );
  const problemRuns = shownData(runs);
  const requests = useInfiniteQuery({
    ...tasksQueryOptions(
      { apiClient, userId, workspaceId: workspace.id },
      {
        kind: 'all',
        view: 'mine',
        status: 'pending',
      },
    ),
    enabled: can('run:read'),
  });
  const workflows = useInfiniteQuery({
    ...workflowsInfiniteQueryOptions(apiClient, userId, workspace.id),
    enabled: can('workflow:read'),
  });
  const setup = useSetupReads({ apiClient, userId, workspace });
  const { connections, destinations } = setup;
  const reads: BlockQuery[] = [
    ...(can('run:read') ? [statistics, requests] : []),
    ...(snapshot === undefined ? [] : [runs]),
    ...(can('workflow:read') ? [workflows] : []),
    ...(setup.canReadConnections ? [connections] : []),
    ...(setup.canReadDestinations ? [destinations] : []),
  ];
  const items = [
    ...taskAttentionItems(
      shownData(requests)?.pages.flatMap((page) => page.items) ?? [],
    ),
    ...(problemRuns === undefined
      ? []
      : runAttentionItems(
          {
            failed: problemRuns.failed.runs,
            timedOut: problemRuns.timedOut.runs,
            outcomeUnknown: problemRuns.outcomeUnknown.runs,
          },
          problemRuns.asOf,
        )),
    ...workflowAttentionItems(
      workflows.data?.pages.flatMap((page) => page.items) ?? [],
    ),
    ...connectionAttentionItems({
      connections: connections.data?.items ?? [],
      canManage: can('connection:manage'),
    }),
    ...destinationAttentionItems(destinations.data?.items ?? []),
  ];
  const samples =
    problemRuns === undefined
      ? []
      : [problemRuns.failed, problemRuns.timedOut, problemRuns.outcomeUnknown];
  const listedFailures = new Set(
    samples
      .flatMap(({ runs }) => runs)
      .filter((run) => run.failedStep != null || run.failureReasonCode != null)
      .map((run) => run.id),
  );
  const failures = useRunFailures({
    apiClient,
    userId,
    workspace,
    runIds: items
      .slice(0, COLLAPSED_LIST_COUNT)
      .flatMap((item) =>
        item.action?.kind === 'run' && !listedFailures.has(item.action.runId)
          ? [item.action.runId]
          : [],
      ),
  });
  const [main, ...others] = reads;
  if (main === undefined) return null;
  const hasMoreFailedRuns = samples.some((sample) => sample.more);
  return (
    <NeedsAttention
      workspace={workspace}
      items={items.map((item) =>
        item.action?.kind === 'run'
          ? withRunFailure(item, failures.get(item.action.runId))
          : item,
      )}
      state={mergedBlockState(main, others)}
      moreFailedRuns={hasMoreFailedRuns}
      moreWorkflows={workflows.hasNextPage}
    />
  );
}
