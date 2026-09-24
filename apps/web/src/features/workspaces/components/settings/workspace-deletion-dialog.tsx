import { useId, useState } from 'react';
import { workspaceDeletionRequestSchema } from '@pertexo/contracts/schemas/identity-workspace';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Notice } from '@/components/ui/notice';
import { Textarea } from '@/components/ui/textarea';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { ValidatedField } from '@/components/ui/validated-field';

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

  function changeOpen(next: boolean) {
    if (next) setOpen(true);
    else if (!pending && !retryAvailable) closeAndReset();
  }

  async function submit() {
    if (retryAvailable) {
      if (await onRetry()) closeAndReset();
      return;
    }
    const valid = validation.submit({
      confirmation: confirmationError(confirmation),
      reason: reasonError(reason),
    });
    if (!valid) return;
    const parsed = workspaceDeletionRequestSchema.parse({ reason });
    if (await onRequest(parsed.reason)) closeAndReset();
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger render={<Button type="button" variant="destructive" />}>
        Delete workspace
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Delete {workspaceName}?</DialogTitle>
        <DialogDescription>
          Access and triggers stop now. You can restore it for 30 days after the
          request; after that it’s deleted for good.
        </DialogDescription>
        <form
          noValidate
          className="mt-6 flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup>
            <ValidatedField
              id={`${id}-confirmation`}
              label={`Type ${workspaceName} to confirm`}
              error={validation.error('confirmation')}
              thread={validation.thread('confirmation')}
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
                  onBlur={() => {
                    validation.blur(
                      'confirmation',
                      confirmationError(confirmation),
                    );
                  }}
                />
              )}
            </ValidatedField>
            <ValidatedField
              id={`${id}-reason`}
              label="Reason"
              description="Recorded with the request so other owners know why."
              error={validation.error('reason')}
              thread={validation.thread('reason')}
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
                  onBlur={() => {
                    validation.blur('reason', reasonError(reason));
                  }}
                />
              )}
            </ValidatedField>
          </FieldGroup>
          {error === undefined ? null : (
            <Notice
              role="alert"
              tone={retryAvailable ? 'attention' : 'failure'}
            >
              {error}
            </Notice>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {retryAvailable ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  onDismissUncertain();
                  closeAndReset();
                }}
              >
                Close
              </Button>
            ) : (
              <DialogClose
                disabled={pending}
                render={<Button type="button" variant="ghost" />}
              >
                Cancel
              </DialogClose>
            )}
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? <LoadingOrb data-icon="inline-start" /> : null}
              {pending
                ? 'Requesting…'
                : retryAvailable
                  ? 'Try again'
                  : 'Delete workspace'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
