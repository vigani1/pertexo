import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { useQueries } from '@tanstack/react-query';
import {
  describeRunFailure,
  type RunFailure,
} from '@/features/workflow-runs/failure.public';
import {
  workflowRunQueryOptions,
  workflowRunVersionQueryOptions,
} from '@/features/workflow-runs/queries.public';
import type { ApiClient } from '@/lib/api/client';

/**
 * Where and why each listed run failed: its run read (the same one its page
 * uses) and, for step names, the version it ran. Runs still loading or
 * unreadable are simply missing, so their items keep their counts.
 */
export function useRunFailures({
  apiClient,
  userId,
  workspace,
  runIds,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  runIds: readonly string[];
}>): ReadonlyMap<string, RunFailure> {
  const canReadVersions = workspace.capabilities.includes('workflow:read');
  const snapshots = useQueries({
    queries: runIds.map((runId) => ({
      ...workflowRunQueryOptions(apiClient, userId, workspace.id, runId),
      staleTime: 60_000,
    })),
  });
  const versions = useQueries({
    queries: snapshots.map((snapshot) => {
      const run = snapshot.data?.run;
      return {
        ...workflowRunVersionQueryOptions(
          apiClient,
          userId,
          workspace.id,
          run?.workflowId ?? '',
          run?.workflowVersionId ?? '',
        ),
        enabled: canReadVersions && run !== undefined,
      };
    }),
  });
  return new Map(
    runIds.flatMap((runId, index) => {
      const snapshot = snapshots[index]?.data;
      return snapshot === undefined
        ? []
        : [
            [
              runId,
              describeRunFailure(snapshot, versions[index]?.data?.graph),
            ] as const,
          ];
    }),
  );
}
