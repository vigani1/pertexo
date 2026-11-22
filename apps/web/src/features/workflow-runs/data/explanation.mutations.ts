import {
  explainFailedRunResultSchema,
  explanationDisclosureSchema,
} from '@pertexo/contracts';
import { useMutation } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';

export function useRunExplanation(
  apiClient: ApiClient,
  workspaceId: string,
  runId: string,
) {
  const path =
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/explanation` as const;
  const disclosure = useMutation({
    mutationFn: () =>
      apiClient.request({
        path,
        response: {
          kind: 'json',
          decode: (value) => explanationDisclosureSchema.parse(value),
        },
      }),
  });
  const explanation = useMutation({
    mutationFn: (confirmation: string) =>
      apiClient.request({
        path,
        method: 'POST',
        body: { confirmation },
        response: {
          kind: 'json',
          decode: (value) => explainFailedRunResultSchema.parse(value),
        },
      }),
  });
  return { disclosure, explanation };
}
