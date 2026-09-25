import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { attentionRunsQueryOptions } from '@/features/workflow-runs/queries.public';
import { workflowsInfiniteQueryOptions } from '@/features/workflows/queries.public';
import type { ApiClient } from '@/lib/api/client';
import {
  connectionAttentionItems,
  destinationAttentionItems,
  runAttentionItems,
  withRunFailure,
  workflowAttentionItems,
} from '../model/needs-attention';
import { mergedBlockState, type BlockQuery } from '../model/home-block-state';
import { NEEDS_ATTENTION_LIMIT, NeedsAttention } from './needs-attention';
import { useRunFailures } from '../use-run-failures';
import { useSetupReads } from '../use-setup-reads';

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
  const runs = useQuery({
    ...attentionRunsQueryOptions(apiClient, userId, workspace.id),
    enabled: can('run:read'),
  });
  const workflows = useInfiniteQuery({
    ...workflowsInfiniteQueryOptions(apiClient, userId, workspace.id),
    enabled: can('workflow:read'),
  });
  const setup = useSetupReads({ apiClient, userId, workspace });
  const { connections, destinations } = setup;
  const reads: BlockQuery[] = [
    ...(can('run:read') ? [runs] : []),
    ...(can('workflow:read') ? [workflows] : []),
    ...(setup.canReadConnections ? [connections] : []),
    ...(setup.canReadDestinations ? [destinations] : []),
  ];
  const items = [
    ...(runs.data === undefined
      ? []
      : runAttentionItems(
          {
            failed: runs.data.failed.runs,
            timedOut: runs.data.timedOut.runs,
            outcomeUnknown: runs.data.outcomeUnknown.runs,
          },
          runs.data.asOf,
        )),
    ...workflowAttentionItems(
      workflows.data?.pages.flatMap((page) => page.items) ?? [],
    ),
    ...connectionAttentionItems(
      connections.data?.items ?? [],
      can('connection:manage'),
    ),
    ...destinationAttentionItems(destinations.data?.items ?? []),
  ];
  const failures = useRunFailures({
    apiClient,
    userId,
    workspace,
    runIds: items
      .slice(0, NEEDS_ATTENTION_LIMIT)
      .flatMap((item) =>
        item.action?.kind === 'run' ? [item.action.runId] : [],
      ),
  });
  const [main, ...others] = reads;
  if (main === undefined) return null;
  return (
    <NeedsAttention
      workspace={workspace}
      items={items.map((item) =>
        item.action?.kind === 'run'
          ? withRunFailure(item, failures.get(item.action.runId))
          : item,
      )}
      state={mergedBlockState(main, others)}
      moreFailedRuns={
        runs.data !== undefined &&
        (runs.data.failed.more ||
          runs.data.timedOut.more ||
          runs.data.outcomeUnknown.more)
      }
    />
  );
}
