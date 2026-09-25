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
 * uses) and, for step names, the version it ran, read once per version even
 * when several runs share it. Runs still loading or unreadable are simply
 * missing, so their items keep their counts.
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
  const uniqueRunIds = [...new Set(runIds)];
  const snapshots = useQueries({
    queries: uniqueRunIds.map((runId) => ({
      ...workflowRunQueryOptions(apiClient, userId, workspace.id, runId),
      staleTime: 60_000,
    })),
  });
  // One read per version the loaded runs ran, so no two queries share a key.
  const ran = new Map(
    snapshots.flatMap((snapshot) => {
      const run = snapshot.data?.run;
      return run === undefined ? [] : [[versionKey(run), run] as const];
    }),
  );
  const versionReads = [...ran.values()];
  const versions = useQueries({
    queries: versionReads.map((run) => ({
      ...workflowRunVersionQueryOptions(
        apiClient,
        userId,
        workspace.id,
        run.workflowId,
        run.workflowVersionId,
      ),
      enabled: canReadVersions,
    })),
  });
  const graphs = new Map(
    versionReads.map((run, index) => [
      versionKey(run),
      versions[index]?.data?.graph,
    ]),
  );
  return new Map(
    uniqueRunIds.flatMap((runId, index) => {
      const snapshot = snapshots[index]?.data;
      return snapshot === undefined
        ? []
        : [
            [
              runId,
              describeRunFailure(
                snapshot,
                graphs.get(versionKey(snapshot.run)),
              ),
            ] as const,
          ];
    }),
  );
}

function versionKey(
  run: Readonly<{ workflowId: string; workflowVersionId: string }>,
): string {
  return `${run.workflowId}:${run.workflowVersionId}`;
}
