import type { ReactNode } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { useWorkflowReadDenial } from '../data/workflow-read-denial';
/** Only this workflow's own read proves revocation; a missing command target does not. */
export function WorkflowReadBoundary({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  children,
  fallback,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  children: ReactNode;
  fallback: ReactNode;
}>) {
  const denied = useWorkflowReadDenial({
    apiClient,
    userId,
    workspaceId,
    workflowId,
  });
  return denied ? fallback : children;
}
