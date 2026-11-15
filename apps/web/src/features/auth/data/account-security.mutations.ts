import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import type { AccountSecurityLinkStartRequest } from '@pertexo/contracts';
import {
  changeAccountPassword,
  requestAccountEmailChange,
  setupAccountPassword,
  startAccountLink,
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

/**
 * Asks to change the email. Nothing cached changes yet: the address changes
 * only once the person confirms from both inboxes, which signs them out.
 */
export function useRequestAccountEmailChange(apiClient: ApiClient) {
  return useMutation({
    mutationFn: (newEmail: string) =>
      requestAccountEmailChange(apiClient, newEmail),
  });
}

/**
 * Saves the account password: a change needs the current one, and an
 * account that signs in only through a provider sets its first.
 */
export function saveAccountPassword(
  apiClient: ApiClient,
  input: Readonly<{ hasPassword: boolean; current: string; password: string }>,
  signal: AbortSignal,
) {
  return input.hasPassword
    ? changeAccountPassword(
        apiClient,
        { currentPassword: input.current, newPassword: input.password },
        signal,
      )
    : setupAccountPassword(apiClient, input.password, signal);
}

/** Starts linking a sign-in method; the answer is the provider's address. */
export function beginAccountLink(
  apiClient: ApiClient,
  input: AccountSecurityLinkStartRequest,
  signal: AbortSignal,
) {
  return startAccountLink(apiClient, input, signal);
}
