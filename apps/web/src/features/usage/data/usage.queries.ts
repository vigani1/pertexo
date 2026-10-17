import type { UsageTrendPeriod } from '@pertexo/contracts';
import { queryOptions } from '@tanstack/react-query';
import type { WorkflowRunStatisticsWindow } from '@pertexo/contracts';
import {
  loomStatisticsQueryOptions,
  workflowRunKeys,
} from '@/features/workflow-runs/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { getUsageCapacity, getUsageTrends } from './usage.api';
import { forgetDeniedSnapshots } from '../model/usage-access';

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
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function usageActivityQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  window: WorkflowRunStatisticsWindow,
) {
  const options = loomStatisticsQueryOptions(
    apiClient,
    userId,
    workspaceId,
    window,
  );
  const read = options.queryFn;
  if (read === undefined)
    throw new Error('Usage activity requires a statistics reader');
  return queryOptions({
    ...options,
    queryFn: async (context) => {
      try {
        return await read(context);
      } catch (error: unknown) {
        await forgetDeniedSnapshots(
          context.client,
          [...workflowRunKeys.scope(userId, workspaceId), 'statistics'],
          options.queryKey,
          error,
        );
        throw error;
      }
    },
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
    staleTime: 15000,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });
}
