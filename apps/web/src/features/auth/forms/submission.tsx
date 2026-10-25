import type { ReactNode } from 'react';
import { DialogFooter } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { cn } from '@/lib/utils';

/**
 * A sign-in family form inside the lens: its fields, one failure line and the
 * one full-width command, which waits out a rate limit with a countdown.
 */
export function AuthForm({
  failure,
  failureAction,
  className,
  children,
  submission,
  secondaryAction,
}: Readonly<{
  failure: string | undefined;
  /** One way out of the failure, e.g. a link to reset the password. */
  failureAction?: ReactNode;
  className?: string;
  children: ReactNode;
  secondaryAction?: ReactNode;
  submission: Readonly<{
    pending: boolean;
    pendingLabel: string;
    submitLabel: string;
    waitSeconds?: number;
    onSubmit: () => void;
  }>;
}>) {
  const {
    pending,
    pendingLabel,
    submitLabel,
    waitSeconds = 0,
    onSubmit,
  } = submission;

  const submit = (
    <ProgressButton
      type="submit"
      variant="primary"
      className={secondaryAction === undefined ? 'mt-1 w-full' : undefined}
      pending={pending}
      pendingLabel={pendingLabel}
      waitSeconds={waitSeconds}
    >
      {submitLabel}
    </ProgressButton>
  );
  return (
    <form
      noValidate
      className={cn('flex flex-col gap-4', className)}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {children}
      {failure === undefined ? null : (
        <Notice tone="destructive" action={failureAction}>
          {failure}
        </Notice>
      )}
      {secondaryAction === undefined ? (
        submit
      ) : (
        <DialogFooter>
          {secondaryAction}
          {submit}
        </DialogFooter>
      )}
    </form>
  );
}
