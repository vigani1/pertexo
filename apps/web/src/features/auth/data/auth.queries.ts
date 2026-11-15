import {
  QUERY_FRESHNESS,
  QUERY_RETENTION,
  QUERY_RETRIES,
} from '@/lib/api/query-timings';
import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { getAuthenticationCapabilities, getCurrentUser } from './auth.api';

export const currentUserQueryKey = ['identity', 'current-user'] as const;

export function currentUserQueryOptions(apiClient: ApiClient) {
  return queryOptions({
    queryKey: currentUserQueryKey,
    queryFn: ({ signal }) => getCurrentUser(apiClient, signal),
    staleTime: QUERY_FRESHNESS.none,
    gcTime: QUERY_RETENTION.session,
  });
}

export function authenticationCapabilitiesQueryOptions(apiClient: ApiClient) {
  return queryOptions({
    queryKey: ['authentication-capabilities'] as const,
    queryFn: ({ signal }) => getAuthenticationCapabilities(apiClient, signal),
    staleTime: QUERY_FRESHNESS.settled,
    retry: QUERY_RETRIES.once,
  });
}
