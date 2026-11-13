import type { AccessibleWorkspace } from '@pertexo/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { workspaceMembersInfiniteQueryOptions } from '@/features/workspaces/workspaces-queries.public';
import type { ApiClient } from '@/lib/api/client';
import { firstThreadSteps, type FirstThreadFacts } from '../model/first-thread';
import { FirstThread, type FirstRunOffer } from './first-thread';
import { useSetupReads } from '../hooks/use-setup-reads';

/**
 * Getting started. The caller already knows about workflows and runs; this
 * adds what else the role can check (connections, alerts, teammates). After
 * the first run it stays, compact, until every task is done.
 */
export function FirstThreadSection({
  apiClient,
  userId,
  workspace,
  facts,
  firstRun,
  compact = false,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  facts: FirstThreadFacts;
  firstRun?: FirstRunOffer | undefined;
  compact?: boolean;
}>) {
  const { connections, destinations } = useSetupReads({
    apiClient,
    userId,
    workspace,
  });
  const members = useInfiniteQuery({
    ...workspaceMembersInfiniteQueryOptions(apiClient, userId, workspace.id),
    enabled: workspace.capabilities.includes('member:read'),
  });
  const steps = firstThreadSteps({
    ...facts,
    ...(connections.data === undefined
      ? {}
      : { connectionCount: connections.data.items.length }),
    ...(destinations.data === undefined
      ? {}
      : { destinationCount: destinations.data.items.length }),
    ...(members.data === undefined
      ? {}
      : {
          memberCount: members.data.pages.flatMap((page) => page.items).length,
        }),
  });
  if (steps.length === 0) return null;
  if (compact && steps.every((step) => step.done)) return null;
  return (
    <FirstThread
      steps={steps}
      workspaceId={workspace.id}
      firstRun={firstRun}
      compact={compact}
    />
  );
}
