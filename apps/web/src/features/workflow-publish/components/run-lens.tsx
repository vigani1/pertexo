import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { Button } from '@/components/ui/button';
import type { RunIntent } from '@/features/workflow-runs/commands.public';
import {
  RunInputFields,
  useRunInput,
} from '@/features/workflow-runs/run-input.public';

/**
 * Starts the published version with an input and an optional deadline. After
 * an uncertain start it offers the exact same run again, or a new one.
 */
export function RunLens({
  open,
  pending,
  error,
  retryAvailable,
  onOpenChange,
  onStartNew,
  onRetry,
}: Readonly<{
  open: boolean;
  pending: boolean;
  error: string | undefined;
  retryAvailable: boolean;
  onOpenChange: (open: boolean) => void;
  onStartNew: (intent: RunIntent) => Promise<boolean>;
  onRetry: () => Promise<boolean>;
}>) {
  const runInput = useRunInput();

  async function startNew() {
    const intent = runInput.read();
    if (intent !== undefined && (await onStartNew(intent))) onOpenChange(false);
  }

  async function submit() {
    if (!retryAvailable) {
      await startNew();
      return;
    }
    if (await onRetry()) onOpenChange(false);
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Run with input"
      description={
        retryAvailable
          ? 'Retry sends the same run again, with the same input. It can’t start twice. Start a new run to use what’s in the fields now.'
          : 'Starts the published version. The run page opens as soon as it’s accepted.'
      }
      confirmLabel={
        retryAvailable ? 'Retry same run' : 'Start published version'
      }
      pendingLabel="Starting…"
      pending={pending}
      error={error}
      errorTone={retryAvailable ? 'warning' : 'destructive'}
      onConfirm={submit}
      secondaryAction={
        retryAvailable ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => void startNew()}
          >
            Start a new run
          </Button>
        ) : undefined
      }
    >
      <RunInputFields
        idPrefix="run"
        inputLabel="Run input (JSON)"
        runInput={runInput}
        disabled={pending}
      />
    </ConfirmDialog>
  );
}
