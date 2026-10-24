import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import type { ApiTokenListResponse } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { revokeApiToken } from './api-tokens.api';
import { apiTokenKeys } from './api-tokens.queries';

export function useTokenRevocation({
  apiClient,
  userId,
  workspaceId,
  tokenId,
  key,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  tokenId: string;
  key: string;
}>) {
  const queryClient = useQueryClient();
  const queryKey = apiTokenKeys.list(userId, workspaceId);
  return useMutation({
    mutationFn: () => revokeApiToken(apiClient, workspaceId, tokenId, key),
    retry: false,
    onSuccess: async ({ token }) => {
      queryClient.setQueryData<InfiniteData<ApiTokenListResponse>>(
        queryKey,
        (previous) =>
          previous === undefined
            ? undefined
            : {
                ...previous,
                pages: previous.pages.map((page) => ({
                  ...page,
                  items: page.items.map((item) =>
                    item.id === token.id ? token : item,
                  ),
                })),
              },
      );
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: () => queryClient.invalidateQueries({ queryKey }),
  });
}
