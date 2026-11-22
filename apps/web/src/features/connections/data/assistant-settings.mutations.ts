import {
  assistantSettingsResultSchema,
  assistantSettingsSchema,
} from '@pertexo/contracts';
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import type { z } from 'zod';

type Scope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
}>;

export function assistantSettingsQueryOptions({
  apiClient,
  userId,
  workspaceId,
}: Scope) {
  return queryOptions({
    queryKey: [
      'identity',
      userId,
      'workspace',
      workspaceId,
      'assistant-settings',
    ],
    queryFn: ({ signal }) =>
      apiClient.request({
        path: assistantPath(workspaceId),
        signal,
        response: {
          kind: 'json',
          decode: (value) => assistantSettingsSchema.parse(value),
        },
      }),
  });
}

export function useAssistantSettings(scope: Scope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: z.output<typeof assistantSettingsSchema>) =>
      scope.apiClient.request({
        path: assistantPath(scope.workspaceId),
        method: 'PUT',
        body: assistantSettingsSchema.parse(body),
        response: {
          kind: 'json',
          decode: (value) => assistantSettingsResultSchema.parse(value),
        },
      }),
    onSuccess: (result) => {
      if (result.kind === 'saved')
        queryClient.setQueryData(
          assistantSettingsQueryOptions(scope).queryKey,
          { selection: result.selection },
        );
    },
  });
}

function assistantPath(workspaceId: string) {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/assistant` as const;
}
