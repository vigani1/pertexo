import { useEffect } from 'react';
import { useRouteContext, useSearch } from '@tanstack/react-router';
import { LoginPage, loginNoticeFrom } from '@/features/auth/login.public';
import { returnPathFrom } from '@/features/auth/return-path.public';
import { publishSessionChange } from '@/features/auth/session-sync.public';

export function LoginRoute() {
  const { apiClient } = useRouteContext({ from: '/login' });
  const search = useSearch({ from: '/login' });
  // Router search keeps unvalidated raw keys, so check the value again.
  const returnTo = returnPathFrom(search.returnTo);
  useEffect(() => {
    if (search.emailChanged) publishSessionChange();
  }, [search.emailChanged]);
  return (
    <LoginPage
      apiClient={apiClient}
      notice={loginNoticeFrom(search)}
      returnTo={returnTo}
      navigateToProvider={(authorizationUrl) => {
        window.location.assign(authorizationUrl);
      }}
      onAuthenticated={() => {
        // A full navigation starts the signed-in app from a clean slate, at
        // the allowlisted page that asked for the sign-in.
        window.location.assign(returnTo ?? '/');
      }}
    />
  );
}
