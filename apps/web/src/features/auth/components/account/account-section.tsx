import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  accountCommandFailure,
  needsFreshSignIn,
} from '../../model/account-failure';
import { Notice } from '@/components/ui/notice';

/** A flat block on the account page: a title, one short line, the content. */
export function AccountSection({
  id,
  title,
  description,
  action,
  className,
  children,
}: Readonly<{
  id: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}>) {
  return (
    <section
      aria-labelledby={id}
      className={cn(
        'flex flex-col gap-5 border-t border-border pt-6 first:border-t-0 first:pt-0',
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={id} className="text-xl font-semibold">
            {title}
          </h2>
          {description === undefined ? null : (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Rows loading in the shape of the account lists. */
export function AccountRowsPending({ label }: Readonly<{ label: string }>) {
  return (
    <div role="status" className="flex flex-col gap-4">
      <span className="sr-only">{label}</span>
      {[0, 1].map((row) => (
        <div key={row} className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-md" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-2.5 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A read failure that keeps the page usable and offers one retry. */
export function AccountReadFailure({
  message,
  retrying,
  onRetry,
}: Readonly<{ message: string; retrying: boolean; onRetry: () => void }>) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
      <p className="text-destructive">{message}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={retrying}
        onClick={onRetry}
      >
        Try again
      </Button>
    </div>
  );
}

/** "Sign in again" when the server wants a fresh session for a change. */
export function FreshSignInLink({ error }: Readonly<{ error: unknown }>) {
  if (!needsFreshSignIn(error)) return null;
  return (
    <Link
      to="/logout"
      className="text-[0.8rem] font-semibold text-accent-foreground underline-offset-4 hover:underline"
    >
      Sign in again
    </Link>
  );
}

/**
 * A failed account change. When the server wants a fresh sign-in, the line
 * offers it: signing out and back in starts a new session.
 */
export function AccountCommandFailure({
  error,
  action,
  message,
  className,
}: Readonly<{
  error: unknown;
  action: string;
  /** Overrides the generic sentence for a failure the caller understands. */
  message?: string | undefined;
  className?: string;
}>) {
  return (
    <Notice
      tone="destructive"
      {...(className === undefined ? {} : { className })}
      action={<FreshSignInLink error={error} />}
    >
      {message ?? accountCommandFailure(error, action)}
    </Notice>
  );
}
