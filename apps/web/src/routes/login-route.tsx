import { useEffect } from 'react';
import { useRouteContext, useSearch } from '@tanstack/react-router';
import { LoginPage } from '@/features/auth/login.public';
import { publishSessionChange } from '@/features/auth/session-sync.public';

export function LoginRoute() {
  const { apiClient } = useRouteContext({ from: '/login' });
  const search = useSearch({ from: '/login' });
  const notice = loginNotice(search);
  useEffect(() => {
    if (search.emailChanged) publishSessionChange();
  }, [search.emailChanged]);
  return (
    <LoginPage
      apiClient={apiClient}
      {...(notice === undefined ? {} : { notice })}
      navigateToProvider={(authorizationUrl) => {
        window.location.assign(authorizationUrl);
      }}
      onAuthenticated={() => {
        window.location.assign('/');
      }}
    />
  );
}

function loginNotice(
  search: Readonly<{
    emailChanged?: true;
    emailChangePending?: true;
    verificationInvalid?: true;
    linkReauthenticate?: true;
    migrationReauthenticate?: true;
    migrationFailed?: true;
    verified?: true;
    socialError?: true;
  }>,
): string | undefined {
  if (search.emailChanged)
    return 'Your email was changed. Sign in with the new address.';
  if (search.emailChangePending)
    return 'Old address confirmed. Check your new address for the final verification link.';
  if (search.verificationInvalid)
    return 'That verification link is invalid, expired, or already used. Request a new one if needed.';
  if (search.linkReauthenticate)
    return 'Sign in again, then review your methods. A completed link is not repeated by this page.';
  if (search.migrationReauthenticate)
    return 'Sign in using your new provider, then check your workspaces. Migration is never repeated from a receipt.';
  if (search.migrationFailed)
    return 'Account recovery did not complete. No workspace access was transferred. Restart recovery or ask your operator for independent identity review.';
  if (search.verified) return 'Email verified. You can sign in now.';
  if (search.socialError)
    return 'The provider sign-in did not complete. Try again.';
  return undefined;
}
