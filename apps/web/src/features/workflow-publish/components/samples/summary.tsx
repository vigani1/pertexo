import type { StepSampleMetadata } from '@pertexo/contracts';
import { PinIcon } from 'lucide-react';
import { Notice } from '@/components/ui/notice';
import { Status } from '@/components/ui/status';
import { formatRelativeTime } from '@/lib/format/time';
import { sampleStateLabel } from '../../model/testing/samples';
const SOURCE_LABEL: Readonly<
  Record<StepSampleMetadata['source']['kind'], string>
> = {
  json: 'JSON',
  run: 'a workflow run',
  preview: 'a test',
  webhook_test: 'a captured request',
};
export function SampleSummary({
  sample,
  state,
}: Readonly<{
  sample: StepSampleMetadata | null;
  state: StepSampleMetadata['state'] | undefined;
}>) {
  return (
    <>
      <div className="flex items-center gap-2">
        <PinIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-medium">Sample output</h3>
        {state === undefined ? null : (
          <Status tone={state === 'pinned' ? 'success' : 'attention'}>
            {sampleStateLabel[state]}
          </Status>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Tests use pinned output without calling this step. Published runs always
        run for real.
      </p>
      {sample === null ? null : (
        <p className="text-xs text-muted-foreground">
          From {SOURCE_LABEL[sample.source.kind]}. Expires{' '}
          {formatRelativeTime(sample.expiresAt)}.
        </p>
      )}
      <SampleStateNotice state={state} />
    </>
  );
}

function SampleStateNotice({
  state,
}: Readonly<{ state: StepSampleMetadata['state'] | undefined }>) {
  if (state === 'stale')
    return (
      <Notice>
        Setup changed. Review and confirm the sample, replace it, or remove it
        before testing.
      </Notice>
    );
  if (state === 'expired')
    return (
      <Notice>
        This sample expired. Pin fresh data or remove it before testing.
      </Notice>
    );
  return null;
}
