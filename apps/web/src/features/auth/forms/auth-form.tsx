import type { ReactNode } from 'react';
import { Kbd } from '@/components/ui/kbd';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { cn } from '@/lib/utils';

/**
 * A sign-in family form inside the lens: its fields, one failure line and the
 * one full-width command, which waits out a rate limit with a countdown.
 */
export function AuthForm({
  failure,
  pending,
  pendingLabel,
  submitLabel,
  submitKey,
  waitSeconds = 0,
  className,
  onSubmit,
  children,
}: Readonly<{
  failure: string | undefined;
  pending: boolean;
  pendingLabel: string;
  submitLabel: string;
  /** A key hint beside the label, e.g. "↵" on sign in. */
  submitKey?: string;
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
        <Notice tone="destructive">{failure}</Notice>
      )}
      <ProgressButton
        type="submit"
        variant="primary"
        size="lg"
        className="mt-1 w-full"
        pending={pending}
        pendingLabel={pendingLabel}
        waitSeconds={waitSeconds}
      >
        {submitLabel}
        {submitKey === undefined ? null : (
          <Kbd aria-hidden="true">{submitKey}</Kbd>
        )}
      </ProgressButton>
    </form>
  );
}
