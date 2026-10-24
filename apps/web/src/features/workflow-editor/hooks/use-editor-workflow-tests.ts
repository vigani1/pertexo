import { useMemo } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { useWorkflowTests } from '@/features/workflow-publish/tests.public';
import { useEditorStore } from '../model/state/context';

/** Test progress belongs to its saved draft, never to later unsaved edits. */
export function useEditorWorkflowTests({
  apiClient,
  userId,
  workspace,
  workflowId,
  paused,
  ensureSaved,
  verifyIdentity,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
  paused: boolean;
  ensureSaved: () => Promise<{ revision: number }>;
  verifyIdentity: () => Promise<void>;
}>) {
  const revision = useEditorStore((state) => state.revision);
  const graph = useEditorStore((state) => state.graph);
  const saveStatus = useEditorStore((state) => state.saveStatus);
  const scratch = useEditorStore((state) => state.inspectorScratch);
  const tests = useWorkflowTests({
    scope: { apiClient, userId, workspaceId: workspace.id, workflowId },
    enabled:
      !paused &&
      ['workflow:update', 'run:read', 'run:start'].every((capability) =>
        workspace.capabilities.some((value) => value === capability),
      ),
    ensureSaved,
    verifyIdentity,
  });
  const testStatuses = useMemo(
    () =>
      tests.snapshot.data?.draftRevision === revision &&
      saveStatus === 'clean' &&
      !scratch
        ? new Map(
            tests.progress.data?.nodes.map((step) => [
              step.nodeId,
              step.status,
            ]) ?? [],
          )
        : undefined,
    [
      tests.snapshot.data?.draftRevision,
      tests.progress.data?.nodes,
      revision,
      saveStatus,
      scratch,
    ],
  );
  return { tests, testStatuses, revision, graph };
}
