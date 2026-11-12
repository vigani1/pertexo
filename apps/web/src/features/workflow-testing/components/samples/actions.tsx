import type { PreviewRunSummary, StepSampleMetadata } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import type { SampleDialogSource } from '../../model/step-samples';
export function SampleActions({
  sample,
  state,
  preview,
  disabled,
  onOpen,
  onConfirm,
  onRemove,
}: Readonly<{
  sample: StepSampleMetadata | null;
  state: StepSampleMetadata['state'] | undefined;
  preview: PreviewRunSummary | undefined;
  disabled: boolean;
  onOpen: (source: SampleDialogSource) => void;
  onConfirm: (sample: StepSampleMetadata) => void;
  onRemove: (sample: StepSampleMetadata) => void;
}>) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => {
          onOpen('paste');
        }}
      >
        Paste JSON…
      </Button>
      {preview?.status !== 'succeeded' ||
      preview.pinnedSampleId != null ? null : (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            onOpen({ kind: 'preview', previewRunId: preview.id });
          }}
        >
          Pin test output…
        </Button>
      )}
      {sample === null ? null : (
        <>
          {state === 'expired' ? null : (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                onOpen('view');
              }}
            >
              View sample
            </Button>
          )}
          {state !== 'stale' ? null : (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                onConfirm(sample);
              }}
            >
              Confirm for this setup
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              onRemove(sample);
            }}
          >
            Remove pin
          </Button>
        </>
      )}
    </div>
  );
}
