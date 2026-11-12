import { queryOptions } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/error';
import type { ApiClient } from '@/lib/api/client';
import { workflowKeys } from '../workflows.queries';
import { readWorkflowTemplateOrigin } from './workflow-template-origin.api';

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
        const result = await readWorkflowTemplateOrigin(
          apiClient,
          workspaceId,
          workflowId,
          signal,
        );
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
