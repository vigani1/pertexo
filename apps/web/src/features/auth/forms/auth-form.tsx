import type { ReactNode } from 'react';
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
  pending,
  pendingLabel,
  submitLabel,
  waitSeconds = 0,
  className,
  onSubmit,
  children,
}: Readonly<{
  failure: string | undefined;
  /** One way out of the failure, e.g. a link to reset the password. */
  failureAction?: ReactNode;
  pending: boolean;
  pendingLabel: string;
  submitLabel: string;
  waitSeconds?: number;
  className?: string;
  onSubmit: () => void;
  children: ReactNode;
}>) {
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
      <ProgressButton
        type="submit"
        variant="primary"
        className="mt-1 w-full"
        pending={pending}
        pendingLabel={pendingLabel}
        waitSeconds={waitSeconds}
      >
        {submitLabel}
      </ProgressButton>
    </form>
  );
}
