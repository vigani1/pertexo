import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import {
  getAccountSecurity,
  listAccountSecuritySessions,
} from './account-security.api';

export const accountSecurityKeys = {
  scope: (userId: string) => ['account-security', userId] as const,
  methods: (userId: string) =>
    [...accountSecurityKeys.scope(userId), 'methods'] as const,
  sessions: (userId: string) =>
    [...accountSecurityKeys.scope(userId), 'sessions'] as const,
};

export function accountSecurityQueryOptions(
  apiClient: ApiClient,
  userId: string,
) {
  return queryOptions({
    queryKey: accountSecurityKeys.methods(userId),
    queryFn: ({ signal }) => getAccountSecurity(apiClient, signal),
    staleTime: 15_000,
  });
}

export function accountSecuritySessionsQueryOptions(
  apiClient: ApiClient,
  userId: string,
) {
  return queryOptions({
    queryKey: accountSecurityKeys.sessions(userId),
    queryFn: ({ signal }) => listAccountSecuritySessions(apiClient, signal),
    staleTime: 15_000,
  });
}
