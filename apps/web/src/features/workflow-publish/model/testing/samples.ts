import { isApiError } from '@/lib/api/error';
import type { StepSampleMetadata, StepSampleSource } from '@pertexo/contracts';
/** Unsaved setup edits invalidate a pin before the server sees the next save. */
export function currentSampleState(
  sample: StepSampleMetadata,
  binding: string | undefined,
): StepSampleMetadata['state'] {
  if (sample.state === 'expired') return 'expired';
  if (binding === undefined) {
    return sample.state;
  }
  if (sample.binding === binding) {
    return 'pinned';
  }
  return 'stale';
}
export const sampleStateLabel: Readonly<
  Record<StepSampleMetadata['state'], string>
> = { pinned: 'Pinned', stale: 'Pin needs review', expired: 'Pin expired' };

export function sampleErrorDetail(cause: unknown): string | undefined {
  if (isApiError(cause) && cause.problem?.code.startsWith('workflow.sample_'))
    return cause.problem.detail;
  return undefined;
}

export type SampleDialogSource =
  | Exclude<
      StepSampleSource,
      { kind: 'confirm' } | { kind: 'json' } | { kind: 'webhook_test' }
    >
  | 'paste'
  | 'view';
