import { useCallback } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { verifyDuplicateAuthority } from '../model/duplicate/access-loss';

export function useDuplicateAuthority({
  apiClient,
  userId,
  workspaceId,
  retire,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  retire: () => void;
}>) {
  return useCallback(
    async (signal: AbortSignal) => {
      if (
        !(await verifyDuplicateAuthority(
          apiClient,
          userId,
          workspaceId,
          signal,
        ))
      ) {
        retire();
        return false;
      }
      return true;
    },
    [apiClient, userId, workspaceId, retire],
  );
}
