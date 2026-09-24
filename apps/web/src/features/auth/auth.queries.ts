import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { getAuthenticationCapabilities, getCurrentUser } from './auth.api';

const currentUserQueryKey = ['identity', 'current-user'] as const;

export function currentUserQueryOptions(apiClient: ApiClient) {
  return queryOptions({
    queryKey: currentUserQueryKey,
    queryFn: ({ signal }) => getCurrentUser(apiClient, signal),
    staleTime: 0,
    gcTime: 5 * 60_000,
  });
}

export function authenticationCapabilitiesQueryOptions(apiClient: ApiClient) {
  return queryOptions({
    queryKey: ['authentication-capabilities'] as const,
    queryFn: ({ signal }) => getAuthenticationCapabilities(apiClient, signal),
    staleTime: 60_000,
    retry: 1,
  });
}
