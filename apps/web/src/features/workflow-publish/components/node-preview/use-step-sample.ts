import { useQuery } from '@tanstack/react-query';
import type { SampleScope } from '../../data/samples/api';
import { stepSamplesQueryOptions } from '../../data/samples/queries';
import { currentSampleState } from '../../model/testing/samples';
/** Query owns the saved sample; the live draft only derives whether it is still usable. */
export function useStepSample({
  scope,
  nodeId,
  binding,
  enabled,
}: Readonly<{
  scope: SampleScope;
  nodeId: string;
  binding: string | undefined;
  enabled: boolean;
}>) {
  const query = useQuery({
    ...stepSamplesQueryOptions(scope),
    enabled,
    refetchOnMount: false,
  });
  const sample = query.isError
    ? null
    : (query.data?.items.find((item) => item.nodeId === nodeId) ?? null);
  return {
    query,
    sample,
    state: sample === null ? undefined : currentSampleState(sample, binding),
    expectedSampleId: sample?.id ?? null,
  };
}
