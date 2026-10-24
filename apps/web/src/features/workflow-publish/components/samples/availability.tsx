import { QueryView } from '@/components/patterns/states/query-view';
import type { UseQueryResult } from '@tanstack/react-query';
import type {
  PreviewRunSummary,
  StepSampleMetadata,
  StepSampleListResponse,
} from '@pertexo/contracts';
import type { SampleScope } from '../../data/samples/api';
import { SampleControls } from './controls';
export function SampleAvailability({
  query,
  sample,
  scope,
  nodeId,
  state,
  preview,
  ensureSaved,
  disabled,
}: Readonly<{
  query: UseQueryResult<StepSampleListResponse>;
  sample: StepSampleMetadata | null;
  scope: SampleScope;
  nodeId: string;
  state: StepSampleMetadata['state'] | undefined;
  preview: PreviewRunSummary | undefined;
  ensureSaved: () => Promise<Readonly<{ revision: number }>>;
  disabled: boolean;
}>) {
  return (
    <QueryView
      query={query}
      resource="Pinned samples"
      loading={<p role="status">Checking pinned sample…</p>}
    >
      {() => (
        <SampleControls
          scope={scope}
          nodeId={nodeId}
          sample={sample}
          state={state}
          preview={preview}
          ensureSaved={ensureSaved}
          disabled={disabled}
        />
      )}
    </QueryView>
  );
}
