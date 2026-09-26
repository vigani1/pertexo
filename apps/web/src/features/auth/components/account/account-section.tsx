import { Link, useLocation } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { SettingsSection } from '@/components/patterns/settings-section';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  accountCommandFailure,
  needsFreshSignIn,
} from '../../model/account-failure';
import { allowlistedReturnPath, returnToSearch } from '../../model/return-path';
import { Notice } from '@/components/ui/notice';

/**
 * A block on the account page, laid out like every settings page: the title
 * and one short line on the left, the content on the right.
 */
export function AccountSection({
  title,
  description,
  action,
  className,
  children,
}: Readonly<{
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}>) {
  return (
    <SettingsSection
      title={title}
      {...(description === undefined ? {} : { description })}
      {...(action === undefined ? {} : { action })}
      {...(className === undefined ? {} : { className })}
    >
      {children}
    </SettingsSection>
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

/**
 * "Sign in again" when the server wants a fresh session for a change. The
 * new sign-in comes back to this account page.
 */
export function FreshSignInLink({ error }: Readonly<{ error: unknown }>) {
  const pathname = useLocation({ select: (location) => location.pathname });
  if (!needsFreshSignIn(error)) return null;
  return (
    <Link
      to="/logout"
      search={returnToSearch(allowlistedReturnPath(pathname))}
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
