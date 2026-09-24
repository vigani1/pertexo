import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import {
  requestAccountEmailChange,
  revokeAccountSecuritySession,
  revokeOtherAccountSecuritySessions,
  unlinkAccountSecurityMethod,
} from './account-security.api';
import { accountSecurityKeys } from './account-security.queries';

export function useRevokeAccountSession(apiClient: ApiClient, userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      revokeAccountSecuritySession(apiClient, sessionId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: accountSecurityKeys.sessions(userId),
      }),
  });
}

export function useRevokeOtherAccountSessions(
  apiClient: ApiClient,
  userId: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => revokeOtherAccountSecuritySessions(apiClient),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: accountSecurityKeys.sessions(userId),
      }),
  });
}

export function useUnlinkAccountMethod(apiClient: ApiClient, userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (methodId: string) =>
      unlinkAccountSecurityMethod(apiClient, methodId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: accountSecurityKeys.scope(userId),
      }),
  });
}

export function useRequestAccountEmailChange(apiClient: ApiClient) {
  return useMutation({
    mutationFn: (newEmail: string) =>
      requestAccountEmailChange(apiClient, newEmail),
  });
}
