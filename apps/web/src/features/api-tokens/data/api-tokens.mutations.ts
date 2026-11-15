import { useQueryClient } from '@tanstack/react-query';
import { useLatestCommand } from '@/lib/api/commands/use-latest-command';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import {
  tokenCommandFeedback,
  uncertainTokenOutcome,
} from '../model/token-copy';
import type { InfiniteData } from '@tanstack/react-query';
import type {
  ApiTokenCreateRequest,
  ApiTokenListResponse,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { createApiToken, revokeApiToken } from './api-tokens.api';
import { apiTokenKeys } from './api-tokens.queries';

/**
 * Revokes a token with one retained key: an answer that was lost keeps the
 * key for an exact retry within the receipt window. The list shows the
 * revoked token at once and is read again either way.
 */
export function useTokenRevocation({
  apiClient,
  userId,
  workspaceId,
  tokenId,
  onRevoked,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  tokenId: string;
  onRevoked: () => void;
}>) {
  const queryClient = useQueryClient();
  const queryKey = apiTokenKeys.list(userId, workspaceId);
  return useRetainedCommand(
    async (_: null, key: string) => {
      try {
        return await revokeApiToken(apiClient, workspaceId, tokenId, key);
      } catch (cause) {
        await queryClient.invalidateQueries({ queryKey });
        throw cause;
      }
    },
    async ({ token }) => {
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
      onRevoked();
    },
    {
      isUnconfirmed: uncertainTokenOutcome,
      uncertainMessage:
        'Revocation could not be confirmed. Retry the same request, or close and refresh the list.',
      failureMessage: (cause) =>
        tokenCommandFeedback(cause, 'revoking this token').message,
    },
  );
}

/** Reads the token list again, for the page's Refresh. */
export function useTokenListRefresh(userId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      queryKey: apiTokenKeys.list(userId, workspaceId),
    });
  };
}

/**
 * Creates a token. Not a cached mutation: its one-time secret must never
 * enter the query or mutation cache, so the dialog holds it alone. Each
 * attempt is a new command; a replayed answer carries no secret.
 */
export function useApiTokenIssue(apiClient: ApiClient, workspaceId: string) {
  // One creation at a time: a second click must not mint a second token.
  return useLatestCommand(
    (body: ApiTokenCreateRequest, signal: AbortSignal) =>
      createApiToken({
        apiClient,
        workspaceId,
        body,
        idempotencyKey: crypto.randomUUID(),
        signal,
      }),
    { exclusive: true },
  );
}
