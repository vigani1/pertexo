import { usageCapacityResponseSchema } from '@pertexo/contracts/schemas/workflow-runs';
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
