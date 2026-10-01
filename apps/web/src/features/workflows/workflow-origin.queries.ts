import { queryOptions } from '@tanstack/react-query';
import { assertSessionIdentity } from '@/features/auth/session-identity.public';
import { getAllAccessibleWorkspaces } from '@/features/workspaces/queries.public';
import { ApiError } from '@/lib/api/api-error';
import type { ApiClient } from '@/lib/api/client';
import { workflowKeys } from './workflows.queries';
import { readWorkflowTemplateOrigin } from './workflow-origin.api';

// Retained reader presentation is independently gated; writer-off never deletes origin.
export function workflowTemplateOriginPresentationEnabled(): boolean {
  return false;
}

export const workflowTemplateOriginKey = (
  userId: string,
  workspaceId: string,
  workflowId: string,
) =>
  [
    ...workflowKeys.detail(userId, workspaceId, workflowId),
    'projection',
    'templateOrigin',
  ] as const;

async function verifyReadAuthority(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  signal: AbortSignal,
) {
  await assertSessionIdentity(apiClient, userId, signal);
  const workspace = (await getAllAccessibleWorkspaces(apiClient, signal)).find(
    (candidate) => candidate.id === workspaceId,
  );
  if (!workspace?.capabilities.includes('workflow:read'))
    throw new ApiError({
      kind: 'problem',
      message: 'Workflow origin access is unavailable.',
      status: 403,
    });
}

export function workflowTemplateOriginQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  const queryKey = workflowTemplateOriginKey(userId, workspaceId, workflowId);
  return queryOptions({
    queryKey,
    queryFn: async ({ signal, client }) => {
      try {
        await verifyReadAuthority(apiClient, userId, workspaceId, signal);
        const result = await readWorkflowTemplateOrigin(
          apiClient,
          workspaceId,
          workflowId,
          signal,
        );
        await verifyReadAuthority(apiClient, userId, workspaceId, signal);
        if (
          result.workflow.id !== workflowId ||
          result.workflow.workspaceId !== workspaceId
        )
          throw new ApiError({
            kind: 'protocol',
            message: 'Workflow origin response has a different scope.',
          });
        return result;
      } catch (error: unknown) {
        // Neither unsupported projection nor a failed/denied read is authoritative null.
        client
          .getQueryCache()
          .find({ queryKey, exact: true })
          ?.setState({ data: undefined, dataUpdatedAt: 0 });
        throw error;
      }
    },
    staleTime: 0,
    retry: false,
  });
}
