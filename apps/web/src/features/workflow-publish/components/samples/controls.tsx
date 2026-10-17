import { useState } from 'react';
import type { PreviewRunSummary, StepSampleMetadata } from '@pertexo/contracts';
import { PinIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import type { SampleScope } from '../../data/samples/api';
import type { SampleDialogSource } from '../../model/testing/samples';
import { SampleSummary } from './summary';
import { SampleActions } from './actions';
import { PinSampleDialog } from './dialog';
import { useSampleCommand } from './use-command';
export function SampleControls({
  scope,
  nodeId,
  sample,
  state,
  preview,
  ensureSaved,
  disabled,
}: Readonly<{
  scope: SampleScope;
  nodeId: string;
  sample: StepSampleMetadata | null;
  state: StepSampleMetadata['state'] | undefined;
  preview: PreviewRunSummary | undefined;
  ensureSaved: () => Promise<Readonly<{ revision: number }>>;
  disabled: boolean;
}>) {
  const [dialog, setDialog] = useState<SampleDialogSource>();
  const command = useSampleCommand(scope, nodeId, ensureSaved);
  const locked = disabled || command.pending || command.uncertain;
  return (
    <section
      aria-label="Pinned sample"
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
    >
      <SampleSummary sample={sample} state={state} />
      <SampleActions
        sample={sample}
        state={state}
        preview={preview}
        disabled={locked}
        onOpen={setDialog}
        onConfirm={(current) => {
          void command.save({ kind: 'confirm' }, current);
        }}
        onRemove={(current) => {
          void command.save('remove', current);
        }}
      />
      {command.error === undefined ? null : (
        <Notice tone="destructive">{command.error}</Notice>
      )}
      {command.uncertain ? (
        <Button
          size="sm"
          disabled={command.pending || command.expired}
          onClick={command.retry}
        >
          Retry the same change
        </Button>
      ) : null}
      {dialog === undefined ? null : (
        <PinSampleDialog
          scope={scope}
          nodeId={nodeId}
          source={dialog}
          ensureSaved={ensureSaved}
          onClose={() => {
            setDialog(undefined);
          }}
        />
      )}
    </section>
  );
}
export function PinRecordedOutputButton({
  scope,
  nodeId,
  runId,
  nodeRunId,
  ensureSaved,
}: Readonly<{
  scope: SampleScope;
  nodeId: string;
  runId: string;
  nodeRunId: string;
  ensureSaved: () => Promise<Readonly<{ revision: number }>>;
}>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setOpen(true);
        }}
      >
        <PinIcon data-icon="inline-start" />
        Pin output…
      </Button>
      {open ? (
        <PinSampleDialog
          scope={scope}
          nodeId={nodeId}
          source={{ kind: 'run', runId, nodeRunId }}
          ensureSaved={ensureSaved}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
