import { useRef, useState, type SyntheticEvent } from 'react';
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

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
  error?: string;
  onDismissUncertain: () => void;
  onRequest: (reason: string) => Promise<boolean>;
  onRetry: () => Promise<boolean>;
}>) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [validationError, setValidationError] = useState<string>();
  const validationAttempted = useRef(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  function changeOpen(next: boolean) {
    if (!next && retryAvailable) return;
    setOpen(next);
    if (!next) {
      setReason('');
      setValidationError(undefined);
      validationAttempted.current = false;
    }
  }

  async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    if (retryAvailable) {
      if (await onRetry()) changeOpen(false);
      return;
    }
    validationAttempted.current = true;
    const parsed = workspaceDeletionRequestSchema.safeParse({ reason });
    if (!parsed.success) {
      setValidationError('Enter a reason between 1 and 512 characters.');
      reasonRef.current?.focus();
      return;
    }
    setValidationError(undefined);
    if (await onRequest(parsed.data.reason)) changeOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger render={<Button type="button" variant="destructive" />}>
        Request deletion
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Request workspace deletion?</DialogTitle>
        <DialogDescription>
          {workspaceName} will enter deletion pending state. The server owns the
          recovery window and final purge schedule.
        </DialogDescription>
        <form
          className="mt-6 space-y-5"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <Field
            data-invalid={validationError === undefined ? undefined : true}
          >
            <FieldLabel htmlFor="workspace-deletion-reason">Reason</FieldLabel>
            <Textarea
              id="workspace-deletion-reason"
              ref={reasonRef}
              name="reason"
              autoComplete="off"
              value={reason}
              maxLength={512}
              disabled={pending || retryAvailable}
              aria-describedby={
                validationError === undefined
                  ? 'workspace-deletion-description'
                  : 'workspace-deletion-description workspace-deletion-error'
              }
              aria-invalid={validationError === undefined ? undefined : true}
              onChange={(event) => {
                const nextReason = event.target.value;
                setReason(nextReason);
                if (
                  validationAttempted.current ||
                  validationError !== undefined
                )
                  setValidationError(workspaceReasonError(nextReason));
              }}
              onBlur={() => {
                setValidationError(workspaceReasonError(reason));
              }}
            />
            <FieldDescription id="workspace-deletion-description">
              This reason is recorded with the lifecycle command.
            </FieldDescription>
            {validationError === undefined ? null : (
              <FieldError id="workspace-deletion-error">
                {validationError}
              </FieldError>
            )}
          </Field>
          {error === undefined ? null : (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {retryAvailable ? (
            <p className="text-sm text-muted-foreground">
              The original reason and command key are locked until you retry or
              dismiss this uncertain attempt.
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-3">
            {retryAvailable ? (
              <Button
                type="button"
                variant="ghost"
                onClick={onDismissUncertain}
              >
                Dismiss attempt
              </Button>
            ) : (
              <DialogClose render={<Button type="button" variant="ghost" />}>
                Cancel
              </DialogClose>
            )}
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending
                ? 'Submitting…'
                : retryAvailable
                  ? 'Retry request'
                  : 'Request deletion'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function workspaceReasonError(reason: string): string | undefined {
  return workspaceDeletionRequestSchema.safeParse({ reason }).success
    ? undefined
    : 'Enter a reason between 1 and 512 characters.';
}
