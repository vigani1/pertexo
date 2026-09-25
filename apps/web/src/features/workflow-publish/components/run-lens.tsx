import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { Button } from '@/components/ui/button';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import type { RunIntent } from '@/features/workflow-runs/commands.public';
import { useRunInput } from '@/features/workflow-runs/run-input.public';
import { DeadlineField } from './deadline-field';

/**
 * Starts the published version with an input and an optional deadline,
 * picked with Weft's deadline control (none, in an hour, in a day, or a
 * date and time on the person's clock). After an uncertain start it offers
 * the exact same run again, or a new one.
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
      <FieldGroup>
        <LabelledField
          id="run-input"
          label="Run input (JSON)"
          description="Use {} if the workflow doesn’t read any input."
          error={runInput.validation.error('input')}
          thread={runInput.validation.thread('input')}
        >
          {(control) => (
            <Textarea
              {...control}
              ref={runInput.validation.register('input')}
              name="run-input"
              autoComplete="off"
              spellCheck={false}
              className="min-h-32 font-mono text-[0.8rem]"
              disabled={pending}
              value={runInput.input}
              onChange={(event) => {
                runInput.changeInput(event.currentTarget.value);
              }}
              onBlur={runInput.blurInput}
            />
          )}
        </LabelledField>
        <DeadlineField
          value={runInput.deadline}
          error={runInput.validation.error('deadline')}
          thread={runInput.validation.thread('deadline')}
          disabled={pending}
          register={runInput.validation.register('deadline')}
          onChange={runInput.changeDeadline}
          onBlur={runInput.blurDeadline}
        />
      </FieldGroup>
    </ConfirmDialog>
  );
}
