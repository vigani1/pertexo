import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import { useId, useState } from 'react';
import { workspaceDeletionRequestSchema } from '@pertexo/contracts';
import {
  ConfirmDialog,
  ConfirmationFooter,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import { Button } from '@/components/ui/button';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useFieldValidation } from '@/components/ui/use-field-validation';

type WorkspaceDeletionDialogProps = Readonly<{
  workspaceName: string;
  pending: boolean;
  retryAvailable: boolean;
  error: string | undefined;
  onDismissUncertain: () => void;
  onRequest: (reason: string) => Promise<boolean>;
  onRetry: () => Promise<boolean>;
}>;

type DeletionField = 'confirmation' | 'reason';

function reasonError(reason: string): string | undefined {
  return workspaceDeletionRequestSchema.safeParse({ reason }).success
    ? undefined
    : 'Say why in a sentence (up to 512 characters). Other owners will see it.';
}

/**
 * Deleting asks for the workspace's name, typed out, and a reason. It is
 * recoverable for 30 days, and the dialog says so before anything is sent.
 */
export function WorkspaceDeletionDialog({
  workspaceName,
  pending,
  retryAvailable,
  error,
  onDismissUncertain,
  onRequest,
  onRetry,
}: WorkspaceDeletionDialogProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [reason, setReason] = useState('');
  const validation = useFieldValidation<DeletionField>();
  const confirmationError = (value: string) =>
    value.trim() === workspaceName
      ? undefined
      : `Type ${workspaceName} exactly to confirm.`;
  function closeAndReset() {
    setOpen(false);
    setConfirmation('');
    setReason('');
    validation.reset();
  }

  async function send(command: () => Promise<boolean>) {
    if (await command()) closeAndReset();
  }

  async function submit() {
    const valid = validation.submit({
      confirmation: confirmationError(confirmation),
      reason: reasonError(reason),
    });
    if (!valid) return;
    const parsed = workspaceDeletionRequestSchema.parse({ reason });
    await send(() => onRequest(parsed.reason));
  }

  const changeConfirmationOpen = (next: boolean) => {
    if (next) setOpen(true);
    else closeAndReset();
  };
  const confirmationRetry = retryAvailable
    ? { onRetry: () => send(onRetry), onDismiss: onDismissUncertain }
    : undefined;
  return (
    <ConfirmDialog
      state={{
        open: open,
        onOpenChange: changeConfirmationOpen,
        locked: pending || retryAvailable,
      }}
      title={`Delete ${workspaceName}?`}
      description="Access and triggers stop now. You can restore it for 30 days after the request; after that it’s deleted for good."
      trigger={
        <Button type="button" variant="destructive">
          Delete workspace
        </Button>
      }
      onSubmit={confirmationRetry?.onRetry ?? submit}
      submitDisabled={pending}
      footer={
        <ConfirmationFooter>
          {confirmationRetry === undefined ? (
            <DialogClose
              disabled={pending || retryAvailable}
              render={<Button type="button" variant="ghost" />}
            >
              Cancel
            </DialogClose>
          ) : (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                confirmationRetry.onDismiss();
                changeConfirmationOpen(false);
              }}
            >
              Close
            </Button>
          )}
          <ProgressButton
            type="submit"
            variant="destructive"
            pending={pending}
            pendingLabel="Requesting…"
          >
            {confirmationRetry === undefined ? 'Delete workspace' : 'Try again'}
          </ProgressButton>
        </ConfirmationFooter>
      }
    >
      <ConfirmationDetails
        error={error}
        tone={confirmationRetry === undefined ? 'destructive' : 'warning'}
      >
        <FieldGroup>
          <LabelledField
            id={`${id}-confirmation`}
            label={`Type “${workspaceName}” to confirm`}
            error={validation.error('confirmation')}
          >
            {(control) => (
              <Input
                {...control}
                ref={validation.register('confirmation')}
                autoComplete="off"
                spellCheck={false}
                value={confirmation}
                disabled={pending || retryAvailable}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setConfirmation(next);
                  validation.change('confirmation', confirmationError(next));
                }}
              />
            )}
          </LabelledField>
          <LabelledField
            id={`${id}-reason`}
            label="Reason (required)"
            description="Other owners see it with the request."
            error={validation.error('reason')}
          >
            {(control) => (
              <Textarea
                {...control}
                ref={validation.register('reason')}
                name="reason"
                autoComplete="off"
                maxLength={512}
                value={reason}
                disabled={pending || retryAvailable}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setReason(next);
                  validation.change('reason', reasonError(next));
                }}
              />
            )}
          </LabelledField>
        </FieldGroup>
      </ConfirmationDetails>
    </ConfirmDialog>
  );
}
