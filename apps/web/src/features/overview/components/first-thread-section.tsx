import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { useInfiniteQuery } from '@tanstack/react-query';
import { workspaceMembersInfiniteQueryOptions } from '@/features/workspaces/members.queries.public';
import type { ApiClient } from '@/lib/api/client';
import { firstThreadSteps, type FirstThreadFacts } from '../model/first-thread';
import { FirstThread } from './first-thread';
import { useSetupReads } from '../use-setup-reads';

/**
 * The checklist for a workspace that hasn't run anything yet. The caller
 * already knows about workflows and runs; this adds what else the role can
 * check (connections, alerts, teammates).
 */
export function FirstThreadSection({
  apiClient,
  userId,
  workspace,
  facts,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  facts: FirstThreadFacts;
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
  return <FirstThread steps={steps} workspaceId={workspace.id} />;
}
