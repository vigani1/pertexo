import {
  usageCapacityResponseSchema,
  usageTrendsResponseSchema,
  type UsageTrendPeriod,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';

export function getUsageCapacity(
  apiClient: ApiClient,
  workspaceId: string,
  signal: AbortSignal,
) {
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/usage-capacity`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => usageCapacityResponseSchema.parse(value),
    },
  });
}

export function getUsageTrends(
  apiClient: ApiClient,
  workspaceId: string,
  period: UsageTrendPeriod,
  signal: AbortSignal,
) {
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/usage-trends?period=${period}`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => usageTrendsResponseSchema.parse(value),
    },
  });
}
