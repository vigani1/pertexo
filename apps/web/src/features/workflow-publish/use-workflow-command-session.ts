import type { ApiClient } from '@/lib/api/client';
import { useWorkflowPublication } from './mutations/use-workflow-publication';
import { useWorkflowRunSubmission } from './mutations/use-workflow-run-submission';

export type SavedDraftIdentity = Readonly<{
  etag: string;
  generation: number;
  revision: number;
}>;

export function useWorkflowCommandSession({
  apiClient,
  workspaceId,
  workflowId,
  verifyIdentity,
  isSessionPaused,
  ensureSaved,
  onRunAccepted,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  verifyIdentity: () => Promise<void>;
  isSessionPaused: () => boolean;
  ensureSaved: () => Promise<SavedDraftIdentity>;
  onRunAccepted: (runId: string) => void;
}>) {
  const publication = useWorkflowPublication({
    apiClient,
    workspaceId,
    workflowId,
    verifyIdentity,
    ensureSaved,
  });
  const runSubmission = useWorkflowRunSubmission({
    apiClient,
    workspaceId,
    workflowId,
    verifyIdentity,
    isSessionPaused,
    ensureSaved,
    onRunAccepted,
  });

  return { publication, runSubmission } as const;
}

export type WorkflowCommandSession = ReturnType<
  typeof useWorkflowCommandSession
>;
