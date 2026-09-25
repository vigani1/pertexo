import { useId, useState } from 'react';
import { workspaceDeletionRequestSchema } from '@pertexo/contracts/schemas/identity-workspace';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { Button } from '@/components/ui/button';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useFieldValidation } from '@/components/ui/use-field-validation';

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
}: Readonly<{
  workspaceName: string;
  pending: boolean;
  retryAvailable: boolean;
  error: string | undefined;
  onDismissUncertain: () => void;
  onRequest: (reason: string) => Promise<boolean>;
  onRetry: () => Promise<boolean>;
}>) {
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

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else closeAndReset();
      }}
      locked={pending || retryAvailable}
      trigger={
        <Button type="button" variant="destructive">
          Delete workspace
        </Button>
      }
      title={`Delete ${workspaceName}?`}
      description="Access and triggers stop now. You can restore it for 30 days after the request; after that it’s deleted for good."
      tone="destructive"
      confirmLabel="Delete workspace"
      pendingLabel="Requesting…"
      pending={pending}
      error={error}
      onConfirm={submit}
      unconfirmed={
        retryAvailable
          ? { onRetry: () => send(onRetry), onDismiss: onDismissUncertain }
          : undefined
      }
    >
      <FieldGroup>
        <LabelledField
          id={`${id}-confirmation`}
          label={`Type ${workspaceName} to confirm`}
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
          label="Reason"
          description="Recorded with the request so other owners know why."
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
    </ConfirmDialog>
  );
}
