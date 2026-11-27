import { QUERY_FRESHNESS, QUERY_POLLING } from '@/lib/api/query-timings';
import type { UsageTrendPeriod } from '@pertexo/contracts';
import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { getUsageCapacity, getUsageTrends } from './usage.api';
import { forgetDeniedSnapshots } from '@/lib/api/read-denial';

export function usageCapacityQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  const queryKey = [
    'identity',
    userId,
    'workspace',
    workspaceId,
    'usage-capacity',
  ] as const;
  return queryOptions({
    queryKey,
    queryFn: async ({ signal, client }) => {
      try {
        return await getUsageCapacity(apiClient, workspaceId, signal);
      } catch (error: unknown) {
        await forgetDeniedSnapshots(client, queryKey, queryKey, error);
        throw error;
      }
    },
    staleTime: QUERY_FRESHNESS.recent,
    refetchInterval: QUERY_POLLING.status,
    refetchIntervalInBackground: false,
  });
}

export function usageTrendsQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  period: UsageTrendPeriod,
) {
  const scope = [
    'identity',
    userId,
    'workspace',
    workspaceId,
    'usage-trends',
  ] as const;
  const queryKey = [...scope, period] as const;
  return queryOptions({
    queryKey,
    queryFn: async ({ signal, client }) => {
      try {
        return await getUsageTrends(apiClient, workspaceId, period, signal);
      } catch (error: unknown) {
        await forgetDeniedSnapshots(client, scope, queryKey, error);
        throw error;
      }
    },
    // Daily totals barely move, and the read scans up to 90 days of runs.
    staleTime: QUERY_FRESHNESS.settled,
    refetchInterval: QUERY_POLLING.daily,
    refetchIntervalInBackground: false,
  });
}
