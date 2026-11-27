import { Link, useLocation } from '@tanstack/react-router';
import {
  accountCommandFailure,
  needsFreshSignIn,
} from '../../model/account/failure';
import { allowlistedReturnPath, returnToSearch } from '../../model/return-path';
import { Notice } from '@/components/patterns/notices/inline-notice';

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
      className="text-label font-semibold text-accent-foreground underline-offset-4 hover:underline"
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
