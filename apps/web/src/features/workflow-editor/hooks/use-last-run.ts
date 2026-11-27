import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { QUERY_POLLING } from '@/lib/api/query-timings';
import { isActiveRunStatus } from '@/features/workflow-runs/public';
import {
  latestWorkflowRunQueryOptions,
  workflowRunQueryOptions,
} from '@/features/workflow-runs/workflow-runs-queries.public';
import { useEditorStore } from '../model/state/context';
import { lastRunOverlay, type LastRunOverlay } from '../model/canvas/last-run';

/**
 * The workflow's newest run, read onto the canvas: what each step did, and
 * while it runs, which step is working. People who can't read runs see no
 * results. Hiding the results keeps the run in the line above the canvas.
 */
export function useLastRun({
  apiClient,
  userId,
  workspace,
  workflowId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
}>) {
  const readable = workspace.capabilities.includes('run:read');
  const [shown, setShown] = useState(true);
  const graph = useEditorStore((state) => state.graph);
  const latest = useQuery({
    ...latestWorkflowRunQueryOptions(
      apiClient,
      userId,
      workspace.id,
      workflowId,
    ),
    enabled: readable,
  });
  const listed = latest.data ?? null;
  const detail = useQuery({
    ...workflowRunQueryOptions(
      apiClient,
      userId,
      workspace.id,
      listed?.id ?? '',
    ),
    enabled: listed !== null,
    // A live run is followed step by step while the canvas is open.
    refetchInterval: (query) => {
      const run = query.state.data?.run ?? listed;
      return run !== null && isActiveRunStatus(run.status)
        ? QUERY_POLLING.waiting
        : false;
    },
  });
  const snapshot = detail.data;
  const overlay = useMemo<LastRunOverlay | undefined>(
    () =>
      snapshot === undefined
        ? undefined
        : lastRunOverlay(
            graph,
            snapshot.run,
            snapshot.nodes,
            !isActiveRunStatus(snapshot.run.status),
          ),
    [graph, snapshot],
  );
  return {
    overlay,
    shown,
    toggle: () => {
      setShown((current) => !current);
    },
  } as const;
}
