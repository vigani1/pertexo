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
  onRunCommandAccepted,
  onPublicationAccepted,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  verifyIdentity: () => Promise<void>;
  isSessionPaused: () => boolean;
  ensureSaved: () => Promise<SavedDraftIdentity>;
  onRunAccepted: (runId: string) => void;
  onRunCommandAccepted?: () => void;
  onPublicationAccepted?: () => void;
}>) {
  const publication = useWorkflowPublication({
    apiClient,
    workspaceId,
    workflowId,
    verifyIdentity,
    ensureSaved,
    ...(onPublicationAccepted === undefined ? {} : { onPublicationAccepted }),
  });
  const runSubmission = useWorkflowRunSubmission({
    apiClient,
    workspaceId,
    workflowId,
    verifyIdentity,
    isSessionPaused,
    ensureSaved,
    onRunAccepted,
    ...(onRunCommandAccepted === undefined ? {} : { onRunCommandAccepted }),
  });

  return { publication, runSubmission } as const;
}

export type WorkflowCommandSession = ReturnType<
  typeof useWorkflowCommandSession
>;
