import { queryOptions } from '@tanstack/react-query';
import { getStepSample, listStepSamples, type SampleScope } from './api';
export function stepSamplesKey(scope: SampleScope) {
  return [
    'identity',
    scope.userId,
    'workspace',
    scope.workspaceId,
    'workflow',
    scope.workflowId,
    'step-samples',
  ] as const;
}
export function stepSamplesQueryOptions(scope: SampleScope) {
  return queryOptions({
    queryKey: [...stepSamplesKey(scope), 'list'],
    queryFn: ({ signal }) => listStepSamples(scope, signal),
    staleTime: 0,
    retry: false,
  });
}
export function stepSampleQueryOptions(scope: SampleScope, nodeId: string) {
  return queryOptions({
    queryKey: [...stepSamplesKey(scope), 'node', nodeId],
    queryFn: ({ signal }) => getStepSample(scope, nodeId, signal),
    staleTime: 0,
    retry: false,
  });
}
