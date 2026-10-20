import { queryOptions } from '@tanstack/react-query';
import type { SampleScope } from '../samples/api';
import { readWebhookTest } from './api';
export function webhookTestQuery(
  scope: SampleScope,
  nodeId: string,
  id: string,
) {
  return queryOptions({
    queryKey: [
      'identity',
      scope.userId,
      'workspace',
      scope.workspaceId,
      'workflow',
      scope.workflowId,
      'webhook-test-event',
      nodeId,
      id,
    ],
    queryFn: ({ signal }) => readWebhookTest(scope, nodeId, id, signal),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.state === 'waiting' ? 1000 : false,
    refetchIntervalInBackground: false,
  });
}
