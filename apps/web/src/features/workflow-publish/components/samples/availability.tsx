import type { UseQueryResult } from '@tanstack/react-query';
import type {
  PreviewRunSummary,
  StepSampleMetadata,
  StepSampleListResponse,
} from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
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
  if (query.isError)
    return (
      <Notice tone="destructive">
        Pinned samples couldn’t be checked.{' '}
        <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </Notice>
    );
  if (query.data === undefined)
    return <p role="status">Checking pinned sample…</p>;
  return (
    <SampleControls
      scope={scope}
      nodeId={nodeId}
      sample={sample}
      state={state}
      preview={preview}
      ensureSaved={ensureSaved}
      disabled={disabled}
    />
  );
}
